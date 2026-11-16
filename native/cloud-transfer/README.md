# FileZilla official engine source integration

The canvas embeds the **FileZilla Client 3.71.0 engine** (`libfzclient-private`), compiled from preserved upstream source with `--disable-gui`. Connection, directory listing, asynchronous file reads, SFTP upload scheduling, backpressure and SSH encryption run in the official engine and its unmodified fzSSH 1.4.0 / libfilezilla 0.57.0 dependencies. No separate desktop FileZilla application is launched.

`official-bridge.cpp` translates the canvas NDJSON IPC requests to `CFileZillaEngine` commands and handles the canvas-specific host-key confirmation, confined local file descriptors and upload ownership. It does not implement an alternative SFTP WRITE scheduler. The React file browser and Windows private TCP forwarding remain canvas integration code; they are not the FileZilla GUI.

## Source preservation

- `vendor/filezilla-3.71.0`: complete, unmodified FileZilla Client source.
- `vendor/fzssh-1.4.0-upstream`: complete, unmodified fzSSH source used by the active build.
- `vendor/libfilezilla-0.57.0` and `vendor/nettle-3.10.2`: complete, unmodified dependencies.
- `vendor/boost-regex-1.86.0`: unmodified header-only build dependency; its complete Boost license is in `licenses/boost-1.0.txt`.
- `vendor/SOURCES.json`: archive digests, versions, active source directories and legacy patch provenance.

The old `bridge.cpp` and patched `vendor/fzssh-1.4.0` are retained only as historical references. They are not compiled or linked into the active official-engine build. The earlier two-file READDIR patch and the custom 16/128 pending WRITE scheduler are not part of the new engine.

## Build

Run `bash native/cloud-transfer/build-native.sh` inside the existing WSL `Ubuntu-22.04` environment. Build dependencies are checked without automatically installing packages. Sources, libraries, generated headers and the adapter are built under `.cache/native-filezilla-official`; the production adapter is `.cache/native-filezilla-official/bridge/cloud-transfer-bridge`. `--version` reports the actual linked FileZilla, fzSSH and libfilezilla versions. `CANVAS_TRANSFER_ENGINE_BINARY` is an optional local developer override for isolated validation.

The upstream build disables the GUI, FTP, Storj, update checks and D-Bus. The canvas explicitly sets the official engine's `OPTION_TIMEOUT` to zero and disables speed limits. There is no canvas connection, transfer or idle deadline.

On Windows, WSL runs the native engine without a GUI. A one-use loopback endpoint forwards its unchanged SSH stream to a Windows-owned TCP connection. The engine still verifies the configured server's exact SHA-256 host key before authentication. Passwords travel through private stdin, never process arguments or logs. Saved passwords use the separate Windows current-user DPAPI store.

Local uploads are opened beneath their canonical allowed bucket with `openat2` and read using the official asynchronous file reader from the validated descriptor. The adapter stages uploads under a unique temporary remote name and publishes them with standard SFTP rename; an existing final filename is refused. Cancellation removes only the adapter's own staging file. A hard network loss may prevent cleanup until reconnection. The UI's progress follows the official engine's submitted-byte transfer status; success is shown only after the engine finishes writing and publishing the file.

The official engine retains its upstream behavior. It does not carry the old directory callback patch; tests cover normal paged directories and the previously reported edge cases without claiming that every malformed or endlessly empty server response is repaired.

## Notices

FileZilla Client is copyright (C) 2004-2026 Tim Kosse, GPL-3.0-or-later. This software incorporates components from fzssh, copyright (C) 2025-2026 Tim Kosse and Business Follows Srl, AGPL-3.0-or-later with the additional attribution terms preserved in its README. libfilezilla is GPL-2.0-or-later. Nettle's license texts are retained with its source. Preserve the complete corresponding source, license notices, build instructions and visible application attribution when distributing this integration. The IPC adapter is AGPL-3.0-or-later with the fzSSH attribution terms.
