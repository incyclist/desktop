# Incyclist App

This repository contains the main app of the [Incyclist](https://incyclist.com) indoor cycling app.

## Running the app

### Normal run

```bash
npm start
```

In principle, Electron developer tools can be opened at any time with `CTRL+SHIFT+ALT+I`, though this shortcut has not been reliable on Linux in recent releases.

### Development run

```bash
npm run dev
```

Starts the app with Electron developer tools opened automatically. Use this when actively working on the app.


## Building the Installers


### Windows

#### Unsigned Build
` > npm run make`

#### Signed Build for distribution

Windows binaries are signed with an [SSL.com eSigner](https://www.ssl.com/esigner/) code-signing certificate. The private key of such a certificate lives in SSL.com's cloud HSM and cannot be exported, so there is no `.pfx` file. Signing is done by SSL.com's [CodeSignTool](https://github.com/SSLcom/CodeSignTool) (a Java program), which is called for `Incyclist.exe`, `Update.exe` and `Setup.exe` only.

Every file that is signed counts as one signing against your eSigner subscription, so signing is always opt-in.

You need:
- an SSL.com code-signing certificate with eSigner, enrolled for remote signing with an OTP. During OTP setup, copy the text **secret code** shown next to the QR code - CodeSignTool needs it to generate the one-time codes
- Java and a downloaded copy of CodeSignTool

Set these environment variables before running the build:

| Variable | Value |
|---|---|
| `SIGN_WINDOWS` | `true` |
| `CODE_SIGN_TOOL_JAR` | full path of the `code_sign_tool-*.jar` from the CodeSignTool download |
| `SSL_COM_USERNAME` | your SSL.com login |
| `SSL_COM_PASSWORD` | your SSL.com password |
| `SSL_COM_CREDENTIAL_ID` | the credential ID (UUID) of your eSigner certificate |
| `SSL_COM_TOTP_SECRET` | the OTP secret code from the enrollment |

` > npm run make-windows-dist`

In both cases, the result of the build can be found in [./out/make/squirrel.windows/x64/](./out/make/squirrel.windows/x64/)

#### Building and signing with GitHub Actions (fork)

The workflow [win-build.yml](.github/workflows/win-build.yml) builds and optionally signs the installer. To use it for your own version of the app, fork the repository and enable Actions in your fork. Secrets are stored per repository, so your fork needs its own:

- `SETTINGS_FILE`: content of the `config/settings.json` used for the build
- `RELEASE_SERVER`: the update server the app should check
- for signed builds: `SSL_COM_USERNAME`, `SSL_COM_PASSWORD`, `SSL_COM_CREDENTIAL_ID`, `SSL_COM_TOTP_SECRET` (see the table above)

Builds are unsigned by default. To sign, start the workflow manually (Actions → Windows x64 Build → Run workflow) and tick `sign_windows`. After signing, the workflow checks that the files carry a valid signature of the expected certificate subject. That subject defaults to the one of the Incyclist certificate, so set the repository variable `WINDOWS_SIGN_SUBJECT` (for example `CN=Your Name`) to the subject of your own certificate.

### Mac

There are three different build targets for Mac: 

- An unsigned build you can use for local development and testing/debugging
- A signed and notarized build that can be used to ditribute the app outside of the Mac App Store
- A signed build that can be uploaded to the Mac App Store

The process of signing and requirements for local and App Store distributions is explained [here](https://github.com/thebinarysearchtree/forge) and [here](https://github.com/electron/osx-sign), including how to setup the certificates in provisioning profiles that are required for these build targets

In all cases, the result of the build can be found in [./out/make](./out/make)

#### Unsigned Build
` > npm run make`

#### Signed Build for distribution outside AppStore

Before running the build, you need to setup the information so that the script can properly sign. This requires the following steps to be completed:

1) Create an application in the Apple developer portal. 

2) If not done, create an "App Specific password" as described [here](https://docs.digicert.com/en/software-trust-manager/threat-detection/apple-notarization/notarize-apple-binaries.html)

3) Create, download and install a "Developer ID Application" certificate

4) Create a provisionig profile with your "Developer ID Application" Certificate and the application you have created in Step 1.  Dwnload and install the provisioning profile

5) copy the provisioning profile to [./profiles/Distribution.provisionprofile](./profiles/Distribution.provisionprofile)

6) Define the following environment variables:
- _APPLE_ID_:  appleId: usually the email address you used to create your Apple account.

- _APPLE_PASSWORD_: the password you have created in step 2

- _APPLE_TEAM_ID_: that set of characters inside the brackets at the end of your identity name.

- _APPLE_DEVELOPER_: The name ( "<FirstName> <LastName>") of the developer registered in the certificate

Once these steps are done, you can trigger the build using:
` > npm run make-mac-dist`

To build in GitHub Actions instead, fork the repository, enable Actions and store the certificates, provisioning profile and the values from step 6 as secrets in your fork, as read by [mac-build.yml](.github/workflows/mac-build.yml). Then start the workflow manually and tick `sign_mac`.


#### Signed Build for AppStore distribution

This is currently work in progress. I need to implement and verify the process myself and once that is done, I will describe how you could publish your own flavour of Incyclist in the Mac AppStore

` > npm run make-mac-appstore`

### Linux

#### Snap Build
` > npm run make`

#### AppImage Build
` > npm run make-linux`

In both cases, the result of the build can be found in [./out/make](./out/make)

