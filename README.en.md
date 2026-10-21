# Kerio Connect Account Switcher — multiple webmail accounts in one browser

Use two or more **Kerio Connect webmail accounts in the same browser**, on the same domain, with an account switcher in the profile menu. This free, MIT-licensed Windows server add-on keeps account sessions separate, so signing out of one account does not sign out the others.

[**Download the Windows installer or ZIP**](https://github.com/dasterinvalid-hue/kerio-account-switcher/releases/tag/v1.0.2) · [Русская инструкция](https://github.com/dasterinvalid-hue/kerio-account-switcher/blob/main/README.md) · [Report an issue](https://github.com/dasterinvalid-hue/kerio-account-switcher/issues) · [MIT license](https://github.com/dasterinvalid-hue/kerio-account-switcher/blob/main/LICENSE)

## Account controls in 1.0.2

Each account card has a **Выйти (Sign out)** button on the right. It revokes the selected Kerio session and removes its card from this browser; it does not delete the mailbox or messages. Signing out of another account keeps the current page open. Signing out of the active account opens a remaining account, or the login form when none remain. The bottom logout menu item follows the same behavior.

Repeated sign-ins to the same normalized login address share one card. Existing duplicates merge on reload; signing out ends the sessions associated with that card. Other open tabs receive registry changes. Failed logout requests keep the card available for retry.

The new EXE also updates an existing installation, or use `windows/Update-1.0.2.ps1` from a separately extracted ZIP. Reload open webmail tabs after upgrading.

## What it does

- Adds account cards with names and email addresses to the existing Kerio profile menu.
- Supports up to eight saved accounts per browser profile.
- Keeps other sessions available when you sign out of the selected account.
- Uses your existing webmail hostname and HTTPS certificate; no extra subdomains are required.
- Installs once on the Windows mail server. Users do not need a browser extension or desktop application.

A typical use is switching between a personal work mailbox and a department mailbox when you are authorized to sign in to both. This module does not create mailboxes or grant access to them. Kerio still authenticates every account.

## Compatibility and release status

Version **1.0.2 is a pre-release**, targeting **Kerio Connect 10.0.9 (9754) on Windows x64**. Validation was performed on Windows 11 x64. Other Kerio builds and Windows versions need separate testing. The browser must support Service Workers; the repeated-switching checks were performed in a Chromium-based browser.

This is an independent open-source project, not an official GFI plugin. Full ActiveSync, CalDAV, WebDAV, Outlook Connector, SSO and two-factor authentication workflows have not been certified with this gateway. Test the clients your organization uses before rolling it out.

## Install on the Kerio server

1. Back up Kerio and plan a brief interruption. A new installation restarts the Kerio service to transfer HTTPS port 443 to the gateway.
2. Download `KerioAccountSwitcher-Setup-1.0.2.exe` or `KerioAccountSwitcher-1.0.2-windows-x64.zip` from the release page. Compare the file hashes with `SHA256SUMS.txt`.
3. Run the EXE as a Windows administrator on the Kerio server. The installer interface is in Russian. Enter your existing hostname, Kerio directory, module directory and backend HTTPS port (default: 8843).
4. Alternatively, extract the ZIP into a separate folder and run this command from an elevated PowerShell window in that folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Manage-KerioSwitcher.ps1 -Mode Install -HostName mail.example.com
```

Replace `mail.example.com` with your own hostname. Optional parameters include `-KerioPath "D:\Kerio\MailServer"`, `-InstallDir "C:\Program Files\Kerio Account Switcher"` and `-BackendPort 8843`.

The certificate and key in Kerio's `sslcert` directory must be valid for that hostname and trusted by the bundled Node.js runtime. Certificate validation is not disabled. The automatic installer expects direct HTTPS access on port 443 and stops if Kerio is already configured to trust another proxy.

Node.js 24.22.0 x64 is included. The EXE is not publisher-signed, so Windows may display an unknown-publisher prompt. Do not extract a new package over a running installation.

## Add and switch accounts

Open your normal webmail address and click your name or avatar at the top right. Choose **«Добавить аккаунт» (Add account)** and sign in to the second mailbox using Kerio's normal login form. Adding an account opens another tab. Once signed in, the mailbox appears in the profile menu.

Selecting an existing account reloads the Kerio client for that session. It is not an instant swap between preloaded mailboxes. The normal **«Выход» (Sign out)** action ends the selected session only. Expired Kerio sessions still require a new login.

## How session isolation works

```text
Browser → HTTPS :443 → KerioAccountSwitcher Windows service
                              ↓ HTTPS to 127.0.0.1:8843
                          Kerio Connect
```

The primary mailbox stays at `/webmail/`. Additional accounts use paths such as `/_kas/a/<random-id>/webmail/` on the same hostname. The gateway removes that prefix before forwarding requests to Kerio and forwards only the cookies for the selected account. Cookie names and paths are isolated; Secure, HttpOnly and SameSite attributes are preserved.

A small injected script adds the account cards and maps browser requests. A Service Worker handles account navigation. Requests that already have an account prefix go directly through the browser, so navigating away cancels long polls instead of leaving worker-owned requests occupying HTTP connections.

Local and session storage are namespaced per additional account. The shared account list contains identifiers, display names and email addresses, not passwords or authentication tokens. The gateway does not store passwords; credentials are submitted to Kerio, which controls authentication and session expiry.

Kerio's web-client files are not modified. SMTP, IMAP and POP ports remain with Kerio. Other HTTPS traffic on port 443 also passes through the gateway, without injecting the account menu. Session routing within one origin is not a security boundary between mutually untrusted sites.

## Upgrade from 1.0.0 or 1.0.1 to 1.0.2

Version 1.0.1 fixes a Chromium hang after repeated account switching. The original failure was reproduced on the fifth transition; twenty transitions and contact loading then completed successfully after the fix. Automated coverage includes 21 Node.js tests and a PowerShell configuration rollback test.

Extract the new ZIP into a separate directory on the server and run, as administrator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Update-1.0.2.ps1
```

For a custom module directory, add `-InstallDir "D:\Kerio Account Switcher"`. The script validates the package hashes and service path, backs up changed files and restarts only the module if its runtime files change. It restores files if the HTTPS probe fails. KerioMailServer and its configuration are not restarted or modified by this patch.

If the browser was already stuck, save work in other tabs, fully quit the browser and reopen webmail after updating. Clearing cookies or the saved account list is not required.

## Check health or uninstall

```powershell
Get-Service KerioMailServer,KerioAccountSwitcher
Get-Content "C:\Program Files\Kerio Account Switcher\logs\gateway.log" -Tail 30
```

`https://mail.example.com/_kas/health` checks the gateway process, not every Kerio function. Use the supplied HTTPS probe for the certificate, gateway and login page:

```powershell
& "C:\Program Files\Kerio Account Switcher\runtime\node.exe" "C:\Program Files\Kerio Account Switcher\windows\probe.mjs" "C:\Program Files\Kerio Account Switcher\config.json"
```

To remove the module and restore the original HTTPS settings, run as administrator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\Kerio Account Switcher\windows\Manage-KerioSwitcher.ps1" -Mode Uninstall
```

Uninstalling restarts Kerio. It restores the original HTTPS listeners and proxy settings while preserving unrelated configuration, and removes the module's service, firewall rule and added TLS-file permissions. Backups and application files remain for the administrator. If the listeners were manually changed after installation, automatic removal stops to avoid overwriting them.

## Help other Kerio administrators

[Open an issue](https://github.com/dasterinvalid-hue/kerio-account-switcher/issues/new) with your module, Kerio, Windows and browser versions, reproduction steps, and a redacted error message. Do not post passwords, session cookies, TLS private keys, complete server configuration or mailbox contents in a public issue.

Compatibility reports, documentation improvements and pull requests are welcome. The [Russian guide](https://github.com/dasterinvalid-hue/kerio-account-switcher/blob/main/README.md) also describes certificate renewal, timeouts and building the Windows packages from source.

The project is distributed under the [MIT license](https://github.com/dasterinvalid-hue/kerio-account-switcher/blob/main/LICENSE).
