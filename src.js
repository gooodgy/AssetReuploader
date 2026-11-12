"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID, randomBytes, timingSafeEqual } = require("crypto");
const FormData = require("form-data");
const { https } = require("follow-redirects");
const zlib = require("zlib");
const fetch = require("node-fetch");
const { execFile } = require("child_process");
const util = require("util");
const os = require("os");


const exeDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const outputRoot = path.join(exeDir, "output");
const credentialDir = path.join(os.homedir(), ".asset-reuploader");
const credentialFile = path.join(credentialDir, "credentials.json");
const jobs = {};
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ASSETS_PER_JOB = 1000;
const MAX_ACTIVE_JOBS = 1;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const OPEN_CLOUD_MAX_REQUESTS = 120;
const OPEN_CLOUD_WINDOW_MS = 60_000;
const serverToken = randomBytes(32).toString("hex");
const openCloudRequestTimes = [];
const serverLogEntries = [];
const MAX_SERVER_LOG_ENTRIES = 500;
let nextServerLogId = 1;
let openCloudRetryAt = 0;

function loadStoredApiKeys() {
    try {
        const parsed = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.error(`[credentials] Could not load ${credentialFile}: ${err.message}`);
        }
        return {};
    }
}

let storedApiKeys = loadStoredApiKeys();

function getCreatorKeyKey(creatorID, isGroup) {
    return `${isGroup ? "group" : "user"}:${creatorID}`;
}

function saveStoredApiKeys() {
    fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    const temporaryFile = `${credentialFile}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryFile, JSON.stringify(storedApiKeys, null, 2), {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx"
        });
        try {
            fs.chmodSync(temporaryFile, 0o600);
        } catch {
            // Windows permissions are controlled by the parent directory ACL.
        }
        fs.renameSync(temporaryFile, credentialFile);
        try {
            fs.chmodSync(credentialFile, 0o600);
        } catch {
            // Windows permissions are controlled by the parent directory ACL.
        }
    } catch (err) {
        try {
            fs.rmSync(temporaryFile, { force: true });
        } catch {
            // Keep the original persistence error.
        }
        throw err;
    }
}

function listStoredApiKeys() {
    return Object.values(storedApiKeys).map((entry) => ({
        creatorID: entry.creatorID,
        isGroup: entry.isGroup,
        updatedAt: entry.updatedAt
    }));
}

for (const level of ["log", "info", "warn", "error"]) {
    const originalConsoleMethod = console[level].bind(console);
    console[level] = (...args) => {
        serverLogEntries.push({
            id: nextServerLogId++,
            time: new Date().toISOString(),
            level,
            message: util.format(...args)
        });
        if (serverLogEntries.length > MAX_SERVER_LOG_ENTRIES) {
            serverLogEntries.shift();
        }
        originalConsoleMethod(...args);
    };
}

async function waitForOpenCloudRequestSlot(jobInfo) {
    while (true) {
        const now = Date.now();
        while (openCloudRequestTimes.length &&
            openCloudRequestTimes[0] <= now - OPEN_CLOUD_WINDOW_MS) {
            openCloudRequestTimes.shift();
        }

        const windowWait = openCloudRequestTimes.length >= OPEN_CLOUD_MAX_REQUESTS
            ? openCloudRequestTimes[0] + OPEN_CLOUD_WINDOW_MS - now
            : 0;
        const retryWait = Math.max(0, openCloudRetryAt - now);
        const waitMs = Math.max(windowWait, retryWait);
        if (waitMs <= 0) {
            openCloudRequestTimes.push(now);
            return;
        }

        if (jobInfo) {
            jobInfo.openCloudThrottled = true;
            jobInfo.message = `Roblox Open Cloud limit reached; waiting ${Math.ceil(waitMs / 1000)}s to stay within ${OPEN_CLOUD_MAX_REQUESTS} requests per minute...`;
        }
        await sleep(waitMs);
    }
}

async function fetchOpenCloud(url, options, jobInfo) {
    await waitForOpenCloudRequestSlot(jobInfo);
    const response = await fetch(url, options);
    if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryAfterSeconds = Number(retryAfter);
        const retryAfterDate = retryAfter ? Date.parse(retryAfter) : NaN;
        const retryDelay = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : Number.isFinite(retryAfterDate)
                ? Math.max(0, retryAfterDate - Date.now())
                : OPEN_CLOUD_WINDOW_MS;
        openCloudRetryAt = Math.max(openCloudRetryAt, Date.now() + retryDelay);
        if (jobInfo) {
            jobInfo.openCloudRateLimitHit = true;
            jobInfo.message = "Roblox Open Cloud returned HTTP 429. The affected request failed; pausing later requests to respect Retry-After.";
        }
    }
    return response;
}

function addOpenCloudRateNotice(jobInfo, message) {
    if (jobInfo.openCloudRateLimitHit) {
        return `${message} Roblox returned HTTP 429 (the 120-requests-per-minute Open Cloud limit); retry failed assets after the indicated wait.`;
    }
    if (jobInfo.openCloudThrottled) {
        return `${message} Open Cloud requests were paced to stay within the 120-requests-per-minute limit.`;
    }
    return message;
}

function hasValidServerToken(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
        return false;
    }

    const suppliedToken = Buffer.from(authorization.slice(7), "utf8");
    const expectedToken = Buffer.from(serverToken, "utf8");
    return suppliedToken.length === expectedToken.length && timingSafeEqual(suppliedToken, expectedToken);
}

function markJobFinished(jobInfo) {
    jobInfo.finished = true;
    jobInfo.finishedAt = Date.now();
}

function pruneFinishedJobs() {
    const expiration = Date.now() - JOB_RETENTION_MS;
    for (const [jobId, jobInfo] of Object.entries(jobs)) {
        if (jobInfo.finishedAt && jobInfo.finishedAt < expiration) {
            delete jobs[jobId];
        }
    }
}

setInterval(pruneFinishedJobs, 60_000).unref();

function removeJobOutputDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn(`[removeJobOutputDir] Could not remove ${dir}: ${err.message}`);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createAnimationAsset(filePath, creatorID, isGroup, apiKey, oldAssetId, jobInfo) {
    const creationContext = isGroup
        ? { creator: { groupId: parseInt(creatorID, 10) } }
        : { creator: { userId: parseInt(creatorID, 10) } };

    const form = new FormData();
    form.append("request", JSON.stringify({
        assetType: "Animation",
        displayName: `Reuploaded animation ${oldAssetId}`,
        description: `Reuploaded from rbxassetid://${oldAssetId}`,
        creationContext
    }));
    form.append("fileContent", fs.createReadStream(filePath), {
        contentType: "model/x-rbxm",
        filename: path.basename(filePath)
    });

    const response = await fetchOpenCloud("https://apis.roblox.com/assets/v1/assets", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: form
    }, jobInfo);

    if (response.status === 201) {
        const data = await response.json();
        if (!data.assetId) {
            throw new Error(`Animation response missing assetId. Full data: ${JSON.stringify(data)}`);
        }
        return data.assetId;
    }
    if (response.status === 200) {
        const operationData = await response.json();
        const operationId = operationData.operationId || operationData.path?.split("/").pop();
        if (!operationId) {
            throw new Error(`Animation upload returned no operation path. Full data: ${JSON.stringify(operationData)}`);
        }
        return pollOperationUntilDone(operationId, apiKey, jobInfo);
    }

    const errorText = await response.text().catch(() => "");
    throw new Error(`Open Cloud animation upload failed (status ${response.status}): ${errorText}`);
}

async function downloadAssetLegacy(assetId, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`[downloadAssetLegacy] assetId=${assetId} -> ${outputPath}`);
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
        const fileStream = fs.createWriteStream(outputPath);
        https.get(url, (res) => {
            console.log(`[downloadAssetLegacy] Response for assetId ${assetId}: ${res.statusCode}`);
            if (res.statusCode !== 200) {
                fileStream.close();
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                return reject(new Error(`Download failed (status ${res.statusCode}) for assetId ${assetId}`));
            }

            let stream = res;
            const encoding = res.headers["content-encoding"];
            if (encoding === "gzip") {
                console.log("[downloadAssetLegacy] Content-Encoding: gzip -> zlib Gunzip");
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === "deflate") {
                console.log("[downloadAssetLegacy] Content-Encoding: deflate -> zlib Inflate");
                stream = res.pipe(zlib.createInflate());
            }

            stream.pipe(fileStream);
            fileStream.on("finish", () => {
                fileStream.close(() => {
                    console.log(`[downloadAssetLegacy] Finished writing file: ${outputPath}`);
                    resolve();
                });
            });
        }).on("error", (err) => {
            fileStream.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
            reject(err);
        });
    });
}

async function downloadAssetLegacyWithRetries(assetId, outputPath) {
    const maxRetries = 10;
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await downloadAssetLegacy(assetId, outputPath);
            return;
        } catch (err) {
            attempt++;
            if (err.message.includes("429") || err.message.toLowerCase().includes("rate limit")) {
                console.warn(`[downloadAssetLegacyWithRetries] 429 or rate-limit for asset ${assetId}, attempt ${attempt}`);
                if (attempt < maxRetries) {
                    await sleep(1000);
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        } finally {
            await sleep(200);
        }
    }
}

async function pollOperationUntilDone(operationId, apiKey, jobInfo) {
    const baseUrl = "https://apis.roblox.com/assets/v1/operations/";
    while (true) {
        const resp = await fetchOpenCloud(baseUrl + operationId, {
            method: "GET",
            headers: { "x-api-key": apiKey }
        }, jobInfo);
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`Operation poll failed (status ${resp.status}): ${body}`);
        }
        const data = await resp.json();
        if (data.done === true) {
            const finalAssetId = data.assetId || data.response?.assetId;
            if (!finalAssetId) {
                throw new Error(`Operation done but no assetId. Full data: ${JSON.stringify(data)}`);
            }
            return finalAssetId;
        }
        await sleep(2000);
    }
async function createImageAsset(filePath, creatorID, isGroup, apiKey, oldAssetId, jobInfo) {
    const creationContext = isGroup
        ? { creator: { groupId: parseInt(creatorID, 10) } }
        : { creator: { userId: parseInt(creatorID, 10) } };

    const form = new FormData();
    form.append("request", JSON.stringify({
        assetType: "Image",
        displayName: path.basename(filePath),
        description: `Reuploaded from rbxassetid://${oldAssetId}`,
        creationContext
    }));
    form.append("fileContent", fs.createReadStream(filePath), {
        contentType: "image/png"
    });

    const response = await fetchOpenCloud("https://apis.roblox.com/assets/v1/assets", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: form
    }, jobInfo);

                        await downloadAssetLegacyWithRetries(numericId, filePath);
        const data = await response.json();
        if (!data.assetId) {
            throw new Error(`Response missing assetId. Full data: ${JSON.stringify(data)}`);
        }
        const rawModeration = data.moderationResult || data.response?.moderationResult;
        return { newAssetId: data.assetId, rawModeration };
    }
    if (response.status === 200) {
        const opData = await response.json();
        const operationId = opData.operationId || opData.path?.split("/").pop();
        if (!operationId) {
            throw new Error(`Got 200 but no operationId. Full data: ${JSON.stringify(opData)}`);
        }
        const finalAssetId = await pollOperationUntilDone(operationId, apiKey, jobInfo);
        return { newAssetId: finalAssetId, rawModeration: null };
    }

    const errorText = await response.text().catch(() => "");
    throw new Error(`Open Cloud upload failed (status ${response.status}): ${errorText}`);
}

async function getAssetModeration(assetId, apiKey, jobInfo) {
    const url = `https://apis.roblox.com/assets/v1/assets/${assetId}?readMask=moderationResult`;
    const resp = await fetchOpenCloud(url, {
        method: "GET",
        headers: { "x-api-key": apiKey }
    }, jobInfo);
    if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`GET moderation failed (status ${resp.status}): ${body}`);
    }
    const data = await resp.json();
    return data.moderationResult || null;
}

async function createMeshAsset(filePath, creatorID, isGroup, apiKey, oldAssetId, jobInfo) {
    const creationContext = isGroup
        ? { creator: { groupId: parseInt(creatorID, 10) } }
        : { creator: { userId: parseInt(creatorID, 10) } };

    const form = new FormData();
    form.append("request", JSON.stringify({
        assetType: "Mesh",
        displayName: `Reuploaded mesh ${oldAssetId}`,
        description: `Reuploaded from rbxassetid://${oldAssetId}`,
        creationContext
    }));
    form.append("fileContent", fs.createReadStream(filePath), {
        contentType: "model/x-file-mesh-data",
        filename: path.basename(filePath)
    });

    const response = await fetchOpenCloud("https://apis.roblox.com/assets/v1/assets", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: form
    }, jobInfo);

    if (response.status === 201) {
        const data = await response.json();
        if (!data.assetId) {
            throw new Error(`Mesh response missing assetId. Full data: ${JSON.stringify(data)}`);
        }
        return data.assetId;
    }
    if (response.status === 200) {
        const operationData = await response.json();
        const operationId = operationData.operationId || operationData.path?.split("/").pop();
        if (!operationId) {
            throw new Error(`Mesh upload returned no operation path. Full data: ${JSON.stringify(operationData)}`);
        }
        return pollOperationUntilDone(operationId, apiKey, jobInfo);
    }

    const errorText = await response.text().catch(() => "");
    throw new Error(`Open Cloud mesh upload failed (status ${response.status}): ${errorText}`);
}

function prepareOutputDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

async function runJobImages(jobId, assetIDs, creatorID, isGroup, apiKey) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }
    const jobOutputDir = path.join(outputRoot, jobId);

    try {
        console.log(`[runJobImages] Starting job ${jobId} with ${assetIDs.length} assets.`);

        prepareOutputDir(jobOutputDir);

        jobInfo.failures = [];
        jobInfo.moderated = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        const downloaded = [];
        let downloadedCount = 0;

        for (const rbxAssetIdStr of assetIDs) {
            downloadedCount++;

            const match = rbxAssetIdStr.match(/\d+/);
            if (!match) {
                jobInfo.failures.push({
                    assetId: rbxAssetIdStr,
                    stage: "download",
                    error: "Could not parse numeric ID"
                });
                jobInfo.done = downloadedCount;
                jobInfo.message = `Download parse fail: ${rbxAssetIdStr}`;
                continue;
            }

            const numericId = match[0];
            const fileName = `asset_${numericId}.png`;
            const filePath = path.join(jobOutputDir, fileName);

            try {
                await downloadAssetLegacyWithRetries(numericId, filePath);
                downloaded.push({ fileName, oldId: rbxAssetIdStr });
                jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
            } catch (err) {
                console.error(`[runJobImages] Download error for ${rbxAssetIdStr}:`, err);
                jobInfo.failures.push({
                    assetId: rbxAssetIdStr,
                    stage: "download",
                    error: err.message
                });
                jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
            }

            jobInfo.done = downloadedCount;
        }

        jobInfo.done = 0;
        const totalToUpload = downloaded.length;
        let uploadedCount = 0;
        jobInfo.message = "Starting uploads...";

        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);
            const newlyCreated = [];

            for (const item of slice) {
                uploadedCount++;
                const filePath = path.join(jobOutputDir, item.fileName);

                let newAssetId = null;
                let rawModeration = null;
                try {
                    jobInfo.message = `${uploadedCount}/${totalToUpload} uploading...`;
                    const result = await createImageAsset(
                        filePath,
                        creatorID,
                        isGroup,
                        apiKey,
                        item.oldId,
                        jobInfo
                    );
                    newAssetId = result.newAssetId;
                    rawModeration = result.rawModeration;
                } catch (err) {
                    console.error(`[runJobImages] Upload error for ${item.oldId}:`, err);
                    if (err.message.includes("status 401") && err.message.includes("Invalid API Key")) {
                        jobInfo.warnApiKey = true;
                    }
                    jobInfo.failures.push({
                        assetId: item.oldId,
                        stage: "upload",
                        error: err.message
                    });
                    jobInfo.message = `Upload failed: ${item.oldId}`;
                    jobInfo.done = uploadedCount;
                    continue;
                }

                newlyCreated.push({
                    oldId: item.oldId,
                    newId: newAssetId,
                    rawModeration
                });

                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${totalToUpload} uploaded`;
            }

            // updated moderation handling
            for (const entry of newlyCreated) {
                let moderationState = null;

                if (entry.rawModeration && entry.rawModeration.moderationState) {
                    moderationState = entry.rawModeration.moderationState;
                } else {
                    try {
                        const modData = await getAssetModeration(entry.newId, apiKey, jobInfo);
                        moderationState = modData?.moderationState ?? null;
                    } catch {
                        moderationState = "Unknown";
                    }
                }

                if (moderationState && moderationState !== "Approved") {
                    jobInfo.moderated.push({
                        oldId: entry.oldId,
                        newId: `rbxassetid://${entry.newId}`,
                        state: moderationState
                    });
                } else {
                    jobInfo.results.push({
                        oldId: entry.oldId,
                        newId: `rbxassetid://${entry.newId}`
                    });
                }
            }

            if (i + 60 < downloaded.length) {
                jobInfo.message = "Waiting...";
                console.log("[runJobImages] Upload+moderation batch done. Sleeping 60s...");
                await sleep(60_000);
            }
        }

        let finalMsg = `${jobInfo.results.length} assets have been reuploaded.`;
        if (jobInfo.warnApiKey) {
            finalMsg = `Some or all assets failed. The API Key may be invalid.`;
        }
        jobInfo.message = addOpenCloudRateNotice(jobInfo, finalMsg);
        markJobFinished(jobInfo);

        console.log(`[runJobImages] Job ${jobId} complete.
          Approved: ${jobInfo.results.length},
          Moderated: ${jobInfo.moderated.length},
          Failures: ${jobInfo.failures.length}`);
    } catch (err) {
        console.error(`[runJobImages] Fatal error in job ${jobId}:`, err);
        jobs[jobId].message = `Fatal error: ${err.message}`;
        markJobFinished(jobInfo);
    } finally {
        removeJobOutputDir(jobOutputDir);
    }
}

async function runJobAnimations(jobId, assetIDs, creatorID, isGroup, apiKey) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }
    const jobOutputDir = path.join(outputRoot, jobId);

    try {
        console.log(`[runJobAnimations] Starting job ${jobId} with ${assetIDs.length} animations.`);
        prepareOutputDir(jobOutputDir);

        jobInfo.failures = [];
        jobInfo.moderated = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        let downloadedCount = 0;
        const downloaded = [];

        for (let i = 0; i < assetIDs.length; i += 60) {
            const slice = assetIDs.slice(i, i + 60);

            for (const rbxAssetIdStr of slice) {
                downloadedCount++;
                const match = rbxAssetIdStr.match(/\d+/);
                if (!match) {
                    jobInfo.failures.push({
                        assetId: rbxAssetIdStr,
                        stage: "download",
                        error: "Not a numeric ID"
                    });
                    jobInfo.done = downloadedCount;
                    jobInfo.message = `Invalid ID: ${rbxAssetIdStr}`;
                    continue;
                }

                const numericId = match[0];
                const ext = ".rbxmx";
                const fileName = `asset_${numericId}${ext}`;
                const filePath = path.join(jobOutputDir, fileName);

                try {
                    await downloadAssetLegacyWithRetries(numericId, filePath);
                    downloaded.push({ fileName, oldId: rbxAssetIdStr });
                    jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
                } catch (err) {
                    console.error(`[runJobAnimations] Download error for ${rbxAssetIdStr}:`, err);
                    jobInfo.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: err.message });
                    jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
                }
                jobInfo.done = downloadedCount;
            }
        }

        jobInfo.done = 0;
        jobInfo.message = "Starting animation uploads...";
        let uploadedCount = 0;

        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);

            for (const item of slice) {
                uploadedCount++;
                const filePath = path.join(jobOutputDir, item.fileName);

                let newAssetId = null;
                try {
                    jobInfo.message = `${uploadedCount}/${downloaded.length} uploading (animation)...`;
                    newAssetId = await createAnimationAsset(
                        filePath,
                        creatorID,
                        isGroup,
                        apiKey,
                        item.oldId,
                        jobInfo
                    );
                } catch (err) {
                    console.error(`[runJobAnimations] Upload error for ${item.oldId}:`, err);
                    jobInfo.failures.push({ assetId: item.oldId, stage: "upload", error: err.message });
                    jobInfo.message = `Upload failed: ${item.oldId}`;
                    jobInfo.done = uploadedCount;
                    continue;
                }

                jobInfo.results.push({
                    oldId: item.oldId,
                    newId: `rbxassetid://${newAssetId}`
                });

                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${downloaded.length} uploaded (animation)`;
            }
        }

        let msg = `${jobInfo.results.length} assets have been reuploaded.`;
        jobInfo.message = msg;
        markJobFinished(jobInfo);

        console.log(`[runJobAnimations] Job ${jobId} complete.
Animations reuploaded: ${jobInfo.results.length},
Failures: ${jobInfo.failures.length}`);

    } catch (err) {
        console.error(`[runJobAnimations] Fatal error in job ${jobId}:`, err);
        jobInfo.message = `Fatal: ${err.message}`;
        markJobFinished(jobInfo);
    } finally {
        removeJobOutputDir(jobOutputDir);
    }
}


async function runJobMeshes(jobId, assetIDs, creatorID, isGroup, apiKey) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }
    const jobOutputDir = path.join(outputRoot, jobId);

    try {
        console.log(`[runJobMeshes] Starting job ${jobId} with ${assetIDs.length} meshes.`);
        prepareOutputDir(jobOutputDir);

        jobInfo.failures = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        const downloaded = [];
        let downloadedCount = 0;
        for (const rbxAssetIdStr of assetIDs) {
            downloadedCount++;
            const match = rbxAssetIdStr.match(/\d+/);
            if (!match) {
                jobInfo.failures.push({
                    assetId: rbxAssetIdStr,
                    stage: "download",
                    error: "Could not parse numeric ID"
                });
                jobInfo.done = downloadedCount;
                jobInfo.message = `Download parse fail: ${rbxAssetIdStr}`;
                continue;
            }

            const numericId = match[0];
            const fileName = `asset_${numericId}.rbxmesh`;
            const filePath = path.join(jobOutputDir, fileName);

            try {
                await downloadAssetLegacyWithRetries(numericId, filePath);
                downloaded.push({ filePath, oldId: rbxAssetIdStr });
                jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
            } catch (err) {
                console.error(`[runJobMeshes] Download error for ${rbxAssetIdStr}:`, err);
                jobInfo.failures.push({
                    assetId: rbxAssetIdStr,
                    stage: "download",
                    error: err.message
                });
                jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
            }
            jobInfo.done = downloadedCount;
        }

        jobInfo.done = 0;
        const totalToUpload = downloaded.length;
        let uploadedCount = 0;
        jobInfo.message = "Starting mesh uploads...";

        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);

            const newlyCreated = [];
            for (const item of slice) {
                uploadedCount++;
                try {
                    jobInfo.message = `${uploadedCount}/${totalToUpload} uploading mesh...`;
                    const newAssetId = await createMeshAsset(
                        item.filePath,
                        creatorID,
                        isGroup,
                        apiKey,
                        item.oldId,
                        jobInfo
                    );
                    newlyCreated.push({
                        oldId: item.oldId,
                        newId: newAssetId
                    });
                } catch (err) {
                    console.error(`[runJobMeshes] Upload error for ${item.oldId}:`, err);
                    jobInfo.failures.push({
                        assetId: item.oldId,
                        stage: "upload",
                        error: err.message
                    });
                    jobInfo.message = `Upload failed: ${item.oldId}`;
                    jobInfo.done = uploadedCount;
                    continue;
                }
                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${totalToUpload} uploaded (mesh)`;
            }

            newlyCreated.forEach(entry => {
                jobInfo.results.push({
                    oldId: entry.oldId,
                    newId: `rbxassetid://${entry.newId}`
                });
            });

            if (i + 60 < downloaded.length) {
                jobInfo.message = "Waiting...";
                console.log("[runJobMeshes] Upload batch done. Sleeping 60s...");
                await sleep(60_000);
            }
        }

        let finalMsg = `${jobInfo.results.length} mesh(es) reuploaded.`;
        jobInfo.message = addOpenCloudRateNotice(jobInfo, finalMsg);
        markJobFinished(jobInfo);

        console.log(`[runJobMeshes] Job ${jobId} complete.
  Approved: ${jobInfo.results.length},
  Failures: ${jobInfo.failures.length}`);

    } catch (err) {
        console.error(`[runJobMeshes] Fatal error in job ${jobId}:`, err);
        jobInfo.message = `Fatal error: ${err.message}`;
        markJobFinished(jobInfo);
    } finally {
        removeJobOutputDir(jobOutputDir);
    }
}

function handleUpload(req, res, body) {
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (err) {
        console.error("[handleUpload] JSON parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    }

    const { assetIDs, creatorID, isGroup, uploadType } = payload || {};
    console.log("[handleUpload] Received payload:", {
        assetIDs,
        creatorID,
        isGroup,
        uploadType
    });

    if (!Array.isArray(assetIDs) || assetIDs.length === 0 || !creatorID || !uploadType) {
        console.error("[handleUpload] Missing required fields.");
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Missing required fields (assetIDs, creatorID, uploadType)"
        }));
    }
    if (assetIDs.length > MAX_ASSETS_PER_JOB || !assetIDs.every((assetId) =>
        typeof assetId === "string" && /^\s*(?:rbxassetid:\/\/)?\d+\s*$/i.test(assetId)
    )) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: `assetIDs must contain 1-${MAX_ASSETS_PER_JOB} numeric asset IDs.`
        }));
    }
    const creatorIdText = String(creatorID);
    if (!/^[1-9]\d*$/.test(creatorIdText) || !Number.isSafeInteger(Number(creatorIdText))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "creatorID must be a positive numeric ID." }));
    }
    if (!["Images", "Meshes", "Animations"].includes(uploadType)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Unsupported uploadType." }));
    }
    const isGroupCreator = !!isGroup;
    const apiKey = storedApiKeys[getCreatorKeyKey(creatorIdText, isGroupCreator)]?.apiKey;
    if (!apiKey) {
        const creatorType = isGroupCreator ? "group" : "user";
        console.error(`[handleUpload] No server-side API key configured for ${creatorType} ${creatorIdText}.`);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: `No server-side Open Cloud API key is configured for this ${creatorType}. Add one in the server dashboard for creator ID ${creatorIdText}.`
        }));
    }

    pruneFinishedJobs();
    const activeJobCount = Object.values(jobs).filter((jobInfo) => !jobInfo.finished).length;
    if (activeJobCount >= MAX_ACTIVE_JOBS) {
        res.writeHead(429, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Another upload job is already running." }));
    }

    const jobId = randomUUID();
    jobs[jobId] = {
        total: assetIDs.length,
        done: 0,
        finished: false,
        results: [],
        moderated: [],
        failures: [],
        warnApiKey: false,
        message: "Starting reupload job..."
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobId }));

    if (uploadType === "Animations") {
        runJobAnimations(jobId, assetIDs, creatorID, !!isGroup, apiKey || "")
            .catch((err) => {
                console.error(`[handleUpload] Fatal animation job error:`, err);
                jobs[jobId].message = `Fatal: ${err.message}`;
                markJobFinished(jobs[jobId]);
            });
    } else if (uploadType === "Images") {
        runJobImages(jobId, assetIDs, creatorID, !!isGroup, apiKey)
            .catch((err) => {
                console.error(`[handleUpload] Fatal image job error:`, err);
                jobs[jobId].message = `Fatal: ${err.message}`;
                markJobFinished(jobs[jobId]);
            });
    } else if (uploadType === "Meshes") {
        runJobMeshes(jobId, assetIDs, creatorID, !!isGroup, apiKey)
            .catch((err) => {
                console.error(`[handleUpload] Fatal mesh job error:`, err);
                jobs[jobId].message = `Fatal: ${err.message}`;
                markJobFinished(jobs[jobId]);
            });
    } else {
        console.warn(`[handleUpload] Unsupported uploadType: ${uploadType}`);
        jobs[jobId].message = `Error: Unsupported uploadType ${uploadType}`;
        markJobFinished(jobs[jobId]);
    }
}

function handleProgress(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }

    const jobInfo = jobs[jobId];
    const chunkSize = 50;

    const out = {
        total: jobInfo.total,
        done: jobInfo.done,
        message: jobInfo.message,
        finished: jobInfo.finished,
        resultsCount: null,
        moderatedCount: null,
        failuresCount: null,
        chunkSize
    };
    if (jobInfo.finished) {
        out.resultsCount = jobInfo.results.length;
        out.moderatedCount = jobInfo.moderated.length;
        out.failuresCount = jobInfo.failures.length;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
}

function handleChunks(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }
    const offset = parseInt(params.get("offset") || "0", 10);
    const count = parseInt(params.get("count") || "50", 10);

    const jobInfo = jobs[jobId];
    if (!jobInfo.finished) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Job not finished yet. Wait for 'finished' == true." }));
    }
    const results = jobInfo.results;
    const slice = results.slice(offset, offset + count);
    const hasMore = (offset + count) < results.length;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        data: slice,
        offset,
        count,
        total: results.length,
        hasMore
    }));
}

function handleModerated(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }
    const offset = parseInt(params.get("offset") || "0", 10);
    const count = parseInt(params.get("count") || "50", 10);

    const jobInfo = jobs[jobId];
    if (!jobInfo.finished) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Job not finished yet. Wait for 'finished' == true." }));
    }
    const moderated = jobInfo.moderated;
    const slice = moderated.slice(offset, offset + count);
    const hasMore = (offset + count) < moderated.length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        data: slice,
        offset,
        count,
        total: moderated.length,
        hasMore
    }));
}

function renderDashboard() {
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self';">
<title>Asset Reuploader Server</title>
<style>
:root{color-scheme:light;--ink:#17211f;--muted:#60706b;--paper:#f2f5f2;--panel:#fff;--line:#d5dfda;--green:#16745a;--red:#a63838;--amber:#91621a}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 "Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:26px 22px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}
h1{font-size:23px;margin:0 0 4px}.sub{color:var(--muted)}.status{display:flex;align-items:center;gap:8px;color:var(--green);font-weight:600;white-space:nowrap}
.dot{width:9px;height:9px;border-radius:50%;background:#20a575;box-shadow:0 0 0 4px #d8f0e5}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;margin:14px 0;padding:16px}
.token-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:10px}h2{font-size:15px;margin:0}.note{font-size:12px;color:var(--muted);margin:5px 0 12px}
.token-row{display:flex;gap:8px}.token-row input{min-width:0;flex:1;background:#f8faf8;border:1px solid var(--line);border-radius:4px;padding:10px;font:13px/1.4 Consolas,monospace;color:var(--ink)}
button{border:0;border-radius:4px;background:var(--green);color:white;padding:0 14px;font-weight:600;cursor:pointer}button:hover{background:#105d48}
.credential-row{display:grid;grid-template-columns:125px 145px minmax(160px,1fr) auto;gap:8px}.credential-row input,.credential-row select{min-width:0;border:1px solid var(--line);border-radius:4px;padding:9px;background:#fff;color:var(--ink);font:13px "Segoe UI",sans-serif}.key-status{min-height:20px;margin-top:8px;color:var(--green);font-size:12px}.key-status.error{color:var(--red)}.key-list{display:grid;gap:6px;margin-top:10px}.key-entry{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--line);padding:8px 0;font-size:13px}.key-entry button{background:#edf2ef;color:var(--ink);padding:7px 10px}.key-entry button:hover{background:#dce7e1}
.logs-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.logs{height:min(58vh,520px);overflow:auto;background:#111b19;color:#dce7e2;border-radius:4px;padding:10px;font:12px/1.5 Consolas,monospace}
.entry{display:grid;grid-template-columns:78px 72px minmax(0,1fr);gap:10px;padding:3px 0;border-bottom:1px solid #25312e;overflow-wrap:anywhere}.time{color:#8fa49b}.level{font-weight:bold;text-transform:uppercase}.level.warn{color:#f2c56b}.level.error{color:#ff8585}.level.info{color:#7ecab0}.empty{color:#8fa49b;padding:6px 2px}
@media(max-width:700px){main{padding:18px 12px}.top{display:block}.status{margin-top:12px}.token-row,.credential-row{display:flex;flex-direction:column}.token-row button,.credential-row button{height:40px}.entry{grid-template-columns:1fr;gap:1px;padding:7px 0}.time{font-size:11px}.key-entry{align-items:flex-start}}
</style>
</head>
<body><main>
<header class="top"><div><h1>Asset Reuploader</h1><div class="sub">Local server console</div></div><div class="status"><span class="dot"></span>Running on 127.0.0.1:3000</div></header>
<section><div class="token-head"><h2>Local plugin authorization token</h2></div><p class="note">Paste this temporary bearer token into the Studio plugin's Local Server Token field. It changes whenever the server restarts. This is not your Roblox Open Cloud API key.</p><div class="token-row"><input id="token" readonly aria-label="Local plugin authorization token"><button id="copy" type="button">Copy token</button></div></section>
<section><div class="token-head"><h2>Roblox Open Cloud API keys</h2></div><p class="note">Keys are stored locally in the current user's <code>.asset-reuploader/credentials.json</code> file, scoped by creator type and ID. Key values are not sent back to this page. The file is unencrypted; protect this Windows account and file.</p><div class="credential-row"><select id="creator-type" aria-label="Creator type"><option value="user">User</option><option value="group">Group</option></select><input id="creator-id" inputmode="numeric" placeholder="Creator ID" aria-label="Creator ID"><input id="api-key" type="password" autocomplete="new-password" placeholder="Open Cloud API key" aria-label="Open Cloud API key"><button id="save-key" type="button">Save key</button></div><div class="key-status" id="key-status" role="status"></div><div class="key-list" id="key-list"></div></section>
<section><div class="logs-head"><h2>Server logs</h2><span class="note" id="log-count">Waiting for logs...</span></div><div class="logs" id="logs" role="log" aria-live="polite"><div class="empty">Waiting for server output...</div></div></section>
</main>
<script>
const token = ${JSON.stringify(serverToken)};
const tokenField = document.getElementById('token');
const copyButton = document.getElementById('copy');
const logPanel = document.getElementById('logs');
const logCount = document.getElementById('log-count');
const creatorType = document.getElementById('creator-type');
const creatorId = document.getElementById('creator-id');
const apiKeyField = document.getElementById('api-key');
const keyStatus = document.getElementById('key-status');
const keyList = document.getElementById('key-list');
tokenField.value = token;
copyButton.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(token); }
    catch { tokenField.focus(); tokenField.select(); document.execCommand('copy'); }
    copyButton.textContent = 'Copied';
    setTimeout(() => { copyButton.textContent = 'Copy token'; }, 1400);
});
let lastLogId = 0;
async function apiRequest(url, options = {}) {
    const headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(url, Object.assign({}, options, { headers }));
}
function showKeyStatus(message, isError = false) {
    keyStatus.textContent = message;
    keyStatus.classList.toggle('error', isError);
}
async function refreshApiKeys() {
    try {
        const response = await apiRequest('/api-keys');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load configured creators');
        keyList.replaceChildren();
        for (const creator of data.creators) {
            const row = document.createElement('div'); row.className = 'key-entry';
            const label = document.createElement('span'); label.textContent = (creator.isGroup ? 'Group ' : 'User ') + creator.creatorID + ' · key saved';
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
            remove.addEventListener('click', async () => {
                try {
                    const query = '?creatorID=' + encodeURIComponent(creator.creatorID) + '&isGroup=' + creator.isGroup;
                    const result = await apiRequest('/api-keys' + query, { method: 'DELETE' });
                    const resultData = await result.json();
                    if (!result.ok) throw new Error(resultData.error || 'Could not remove key');
                    showKeyStatus('Saved key removed.');
                    refreshApiKeys();
                } catch (error) { showKeyStatus(error.message, true); }
            });
            row.append(label, remove); keyList.appendChild(row);
        }
        if (!data.creators.length) {
            const empty = document.createElement('div'); empty.className = 'note'; empty.textContent = 'No creator keys saved yet.'; keyList.appendChild(empty);
        }
    } catch (error) { showKeyStatus(error.message, true); }
}
document.getElementById('save-key').addEventListener('click', async () => {
    const id = creatorId.value.trim();
    const key = apiKeyField.value;
    if (!/^[1-9]\\d*$/.test(id) || !key.trim()) return showKeyStatus('Enter a positive creator ID and API key.', true);
    try {
        const response = await apiRequest('/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creatorID: id, isGroup: creatorType.value === 'group', apiKey: key })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save API key');
        apiKeyField.value = '';
        showKeyStatus('API key saved for ' + creatorType.value + ' ' + id + '.');
        refreshApiKeys();
    } catch (error) { showKeyStatus(error.message, true); }
});
async function refreshLogs() {
    try {
        const response = await apiRequest('/server-logs?after=' + lastLogId);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (data.entries.length) {
            const empty = logPanel.querySelector('.empty');
            if (empty) empty.remove();
            for (const entry of data.entries) {
                const row = document.createElement('div'); row.className = 'entry';
                const time = document.createElement('span'); time.className = 'time'; time.textContent = new Date(entry.time).toLocaleTimeString();
                const level = document.createElement('span'); level.className = 'level ' + entry.level; level.textContent = entry.level;
                const message = document.createElement('span'); message.textContent = entry.message;
                row.append(time, level, message); logPanel.appendChild(row); lastLogId = entry.id;
            }
            while (logPanel.children.length > ${MAX_SERVER_LOG_ENTRIES}) logPanel.firstElementChild.remove();
            logPanel.scrollTop = logPanel.scrollHeight;
        }
        logCount.textContent = 'Live · ' + lastLogId + ' entries received';
    } catch (error) { logCount.textContent = 'Log connection unavailable'; }
}
refreshApiKeys(); refreshLogs(); setInterval(refreshLogs, 1000);
</script>
</body></html>`;
}

function handleServerLogs(req, res, urlObj) {
        const after = Number(urlObj.searchParams.get("after") || "0");
        if (!Number.isSafeInteger(after) || after < 0) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Invalid log offset." }));
        }

        const entries = serverLogEntries.filter((entry) => entry.id > after);
        res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ entries }));
}

    function handleApiKeyList(req, res) {
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ creators: listStoredApiKeys() }));
    }

    function handleApiKeySave(req, res, body) {
        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Invalid JSON payload." }));
        }

        const creatorIdText = String(payload?.creatorID ?? "");
        const isGroup = payload?.isGroup;
        const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
        if (!/^[1-9]\d*$/.test(creatorIdText) || !Number.isSafeInteger(Number(creatorIdText)) ||
            typeof isGroup !== "boolean" || !apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Provide a positive creator ID, creator type, and valid API key." }));
        }

        const key = getCreatorKeyKey(creatorIdText, isGroup);
        const previousEntry = storedApiKeys[key];
        storedApiKeys[key] = {
            creatorID: creatorIdText,
            isGroup,
            apiKey,
            updatedAt: new Date().toISOString()
        };
        try {
            saveStoredApiKeys();
        } catch (err) {
            if (previousEntry) storedApiKeys[key] = previousEntry;
            else delete storedApiKeys[key];
            console.error(`[credentials] Failed to save API key for ${key}: ${err.message}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Could not save credentials to the server's local credential file." }));
        }

        console.log(`[credentials] Saved Open Cloud API key for ${key}.`);
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ saved: true, creator: { creatorID: creatorIdText, isGroup } }));
    }

    function handleApiKeyDelete(req, res, urlObj) {
        const creatorIdText = urlObj.searchParams.get("creatorID") || "";
        const isGroupText = urlObj.searchParams.get("isGroup");
        if (!/^[1-9]\d*$/.test(creatorIdText) || !Number.isSafeInteger(Number(creatorIdText)) ||
            !["true", "false"].includes(isGroupText)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Provide a valid creatorID and isGroup value." }));
        }

        const key = getCreatorKeyKey(creatorIdText, isGroupText === "true");
        const previousEntry = storedApiKeys[key];
        if (!previousEntry) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "No key is configured for that creator." }));
        }

        delete storedApiKeys[key];
        try {
            saveStoredApiKeys();
        } catch (err) {
            storedApiKeys[key] = previousEntry;
            console.error(`[credentials] Failed to remove API key for ${key}: ${err.message}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Could not update the server's local credential file." }));
        }

        console.log(`[credentials] Removed Open Cloud API key for ${key}.`);
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ removed: true }));
    }

    function readLimitedRequestBody(req, res, maxBytes, onBody) {
        let bodySize = 0;
        let tooLarge = false;
        const chunks = [];
        req.on("data", (chunk) => {
            if (tooLarge) return;
            bodySize += chunk.length;
            if (bodySize > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request body is too large." }));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!tooLarge) onBody(Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", (err) => {
            console.error("[server] Request read error:", err.message);
            if (!res.headersSent) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Could not read request body." }));
            }
        });
    }

function openDashboard() {
        const dashboardUrl = "http://127.0.0.1:3000/";
        if (process.env.ASSET_REUPLOADER_NO_BROWSER === "1") return;

        if (process.platform === "win32") {
                execFile("cmd.exe", ["/c", "start", "", dashboardUrl], { windowsHide: true }, () => {});
        } else if (process.platform === "darwin") {
                execFile("open", [dashboardUrl], () => {});
        } else {
                execFile("xdg-open", [dashboardUrl], () => {});
        }
}

const allowedHosts = new Set(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]);
const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000"
]);

const server = http.createServer((req, res) => {
    if (!allowedHosts.has((req.headers.host || "").toLowerCase())) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Unrecognized Host header." }));
    }
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
    }
    let urlObj;
    try {
        urlObj = new URL(req.url, "http://127.0.0.1:3000");
        if (urlObj.origin !== "http://127.0.0.1:3000") {
            throw new Error("Unexpected request origin");
        }
    } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid request URL." }));
    }

    if (req.method === "GET" && urlObj.pathname === "/") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
        return res.end(renderDashboard());
    }
    if (!hasValidServerToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Missing or invalid local server token." }));
    }

    if (req.method === "POST" && urlObj.pathname === "/upload") {
        let bodySize = 0;
        let tooLarge = false;
        const chunks = [];
        req.on("data", (chunk) => {
            if (tooLarge) return;
            bodySize += chunk.length;
            if (bodySize > MAX_REQUEST_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request body exceeds the 1 MiB limit." }));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) return;
            console.log("[server] Received POST /upload");
            handleUpload(req, res, Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", (err) => {
            console.error("[server] Upload request read error:", err.message);
            if (!res.headersSent) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Could not read request body." }));
            }
        });
    } else if (req.method === "GET" && urlObj.pathname === "/progress") {
        handleProgress(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/chunks") {
        handleChunks(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/moderated") {
        handleModerated(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/server-logs") {
        handleServerLogs(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/api-keys") {
        handleApiKeyList(req, res);
    } else if (req.method === "POST" && urlObj.pathname === "/api-keys") {
        readLimitedRequestBody(req, res, 8192, (body) => handleApiKeySave(req, res, body));
    } else if (req.method === "DELETE" && urlObj.pathname === "/api-keys") {
        handleApiKeyDelete(req, res, urlObj);
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
});

server.listen(3000, "127.0.0.1", () => {
    console.log("[server] Listening on http://127.0.0.1:3000");
    console.log(`[server] Local authorization token (paste into the Studio plugin): ${serverToken}`);
    openDashboard();
});
