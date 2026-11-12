# AssetReuploader
# This is a modification of the original AssetReuploader which updates it to the modern OpenCloud API, alongside ease of use and security fixes.

## AI DISCLAIMER
This was primarily vibe-coded because I hate javascript. If you have a problem with that, feel free to use the original tool. I won't take it personally.

Speaking of ai, here is the incredibly long README it wrote:

Do you: 

- Want to easily move all of your animations meshes or image assets from one group/profile to another?
- Have a lot of free marketplace image assets that you don't own and you want to use EditableImage?

## AssetReuploader is a simple Node.js tool for reuploading and replacing assets in your game through Roblox's Open Cloud. 

### This is GUI based with simple button clicks, meaning no fiddling around in command line interfaces


https://github.com/user-attachments/assets/d79b3754-bd43-4e3f-adf7-7a13f5cfebe7


# v2.0 now with animation support

![RobloxStudioBeta_3pLc5RQYHP](https://github.com/user-attachments/assets/16bd7c71-eb58-4ba0-b01a-3cd9dec70917)

(not sure why this first video came out blurry but oh well)

https://github.com/user-attachments/assets/cbb77677-6da7-4356-933f-8d2ded9ae9f6



https://github.com/user-attachments/assets/47a66f54-7623-4470-8756-56a91d60fa09



https://github.com/user-attachments/assets/8efea7c3-4422-44c6-ba02-7ea957f67820


# How to Use

When you hit search, it'll search for all assets under the selected instance or the datamodel(depending on your setting) that contains one of the selected content properties
(only relevant for image uploads)

![image](https://github.com/user-attachments/assets/e3a6f01b-2d3c-4bfb-87ba-30468a9b13ed)

It'll only consider assets that the target creator(your profile or chosen group) doesn't already own

Then, when you hit Run, 

![image](https://github.com/user-attachments/assets/c21a4468-e219-4bfc-8bef-6be72f203ac0)

The node.js program should take care of the rest!

The node.js program works in 3 phases

- Downloads the assets
- Reuploads the assets under the target creator
- Sends the results back to roblox

The roblox plugin then replaces all occurrences of those assetIDs in the game with the new ones! It also sets an "OldID" attribute on the instances


- ### For image uploads, if any image assets were moderated, it'll spit them out into a folder in the workspace for you so you can handle their reuploads manually if need be

# Setup

- Head over to releases and grab the latest release https://github.com/TylerAtStarboard/ImageReuploader/releases/
  
- Drag AssetReuploader.rbxmx into a studio place, and right click -> Save as Local Plugin
  ![image](https://github.com/user-attachments/assets/4d0701e8-90d8-4c12-8566-987ebf38eeee)


## If you want to reupload image, mesh, or animation assets:

- Head to the Creator Dashboard https://create.roblox.com/dashboard/

- Navigate to Open Cloud for the creator you want to upload to(your profile or a group)
  
![image](https://github.com/user-attachments/assets/9d70d46b-c485-43f0-8916-8115bc6032f0)

- Create a new API key

- Grant the key Assets read/write access for the target creator and add your IP address to its allowlist. Images, meshes, and animations use the Open Cloud Assets API and require this key.
- Generate a new API key.

![image](https://github.com/user-attachments/assets/f536711d-c53d-4452-aabf-f38c3734fc35)

- Start the Node.js server and open its local dashboard. Select User or Group, enter the matching creator ID, and save the API key there. The plugin now sends only the creator ID; the server selects the stored key for that creator.

- Make sure the saved key's creator type and ID match the target selected in the plugin.
- Keys persist across server restarts in `.asset-reuploader/credentials.json` under the current user's home directory. The file is unencrypted; protect your account and do not share the file or dashboard with untrusted users.

- For mesh uploads, Roblox only accepts mesh data downloaded from the Asset Delivery API; custom mesh files are not supported by this upload flow.

![image](https://github.com/user-attachments/assets/a4b8bc18-fbce-4574-bd1f-602a1526a688)

# Local server authorization

- Start the Node.js server before running an upload. It opens a local dashboard with live server logs and a copy button for the temporary local authorization token. The same token is also printed in the console.
- This is the plugin's local bearer token, not the Roblox Open Cloud API key.
- In the updated Studio plugin, paste that token into **Local Server Token** under **Upload Settings**.
- The token changes whenever the server restarts. Do not share screenshots or logs containing it.
- If you use an already-installed local plugin, save the updated `AssetReuploader.rbxmx` as a Local Plugin again so it includes token support.
- Image, mesh, and animation uploads use the Open Cloud Assets API and require the matching creator's API key in the server dashboard. Asset downloads are unauthenticated; no Roblox session cookie is requested or stored.

# Building from Source

- Install node.js
- Navigate to the project directory and open the terminal
- Enter these commands
- npm install -g pkg
- npm run build-exe

# Notes

- Open Cloud requests are capped at 120 requests per rolling minute. The limiter includes uploads, operation polling, and moderation lookups because they share the API-key request quota. If the local cap is reached, the job reports that it is waiting; if Roblox returns HTTP 429, the affected asset is recorded as failed and the final job status explains the rate limit.
- Roblox applies this quota across API keys for a creator, so other tools using the same creator's keys can still cause an HTTP 429.
- The conversion process can take several minutes for hundreds of assets, especially when it must wait for rate-limit slots.

- This is the first real distributed tool/software I've ever made. It was a quick tool made for my studio that I decided to share with you all.
  - This means a few things:
    - There might be issues and I'm a busy person working on my games so I might not be able to maintain this very quickly
    - The code is kinda fugly, I hate making plugins and do it out of necessity :D


