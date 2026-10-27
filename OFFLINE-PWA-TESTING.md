# Offline and PWA Acceptance Tests

Use the deployed GitHub Pages app at `https://allanorabaasa-hash.github.io/biztrack/` or a local HTTP server. Have a working BizTrack account and note its current workspace before testing. Do not clear site data until any unsynced changes have been synchronized.

## PWA installation and shell

1. Open the app in Chrome and sign in. Open DevTools > Application.
2. Under Manifest, confirm the BizTrack name, standalone display, `/biztrack/` scope/start URL, and the 192 px, 512 px, and maskable icons.
3. Under Service Workers, confirm `sw.js` is activated and controls the page. Under Cache Storage, confirm the versioned BizTrack shell contains the app, local Supabase bundle, manifest, and icons.
4. Reload once, then make a small app code/cache version change in a test deployment. Confirm the current page shows “New version available — Reload” and only reloads after clicking it.

## Offline records and synchronization

1. In DevTools > Network, select Offline. Refresh the app, unlock with the account password, and confirm the workspace opens from this device.
2. Add a business, then add or edit records. Confirm each operation remains available and the header/drawer reports “Offline — changes saved on this device”.
3. While still offline, refresh again and confirm those records remain present.
4. Select Online. Wait for the debounced sync or click “Sync now”. Confirm the status becomes “Synced” with a last-sync time.
5. Open the same account in two browsers/devices. Add different records on both while disconnected, reconnect, and confirm both additions remain. Edit the same record on both; confirm the newer `updated_at` version wins. Delete a record on one side while the other has a stale copy; confirm the tombstone prevents it from returning.

## Offline unlock and logout

1. Sign in online once on a device and allow its encrypted workspace to sync.
2. Select Offline in DevTools > Network, refresh, enter the same email and password, and confirm the local workspace opens. Repeat with a wrong password and confirm it is rejected.
3. Leave the app inactive for 30 minutes and confirm it locks; verify the password unlock works without a connection.
4. Make an offline change and choose Log out. Confirm the app offers to sync first and that logging out without sync preserves the encrypted local copy. On a clean synced workspace, confirm the separate “Remove this device's offline data?” prompt controls whether the copy is retained.
5. In DevTools > Application > IndexedDB, inspect the `workspaces` store. Confirm workspace records contain ciphertext, wrapped key material, and salt, not plaintext business or transaction collections.

## Android installation

1. Open the deployed GitHub Pages URL in Chrome on Android and sign in at least once.
2. Open Chrome’s menu and choose Install app or Add to Home screen.
3. Launch BizTrack from the home screen, verify standalone display, then enable Airplane mode and confirm the app shell and previously cached workspace still open.
