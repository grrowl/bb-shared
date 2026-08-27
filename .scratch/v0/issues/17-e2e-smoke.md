Status:
Type: task
Blocked by: 07, 09, 10, 11, 12, 14, 15, 16

End-to-end smoke test — walk through the full flow from a clean install.

- Install plugin.
- Deploy worker (verify latency and URL).
- Mint a token, add current thread as `write`.
- Copy URL, open in incognito browser.
- Verify: sidebar shows only the shared thread; Settings/Extensions/New-Thread
  hidden; can view transcript; can send a message and it appears in
  the owner's view.
- Add a second thread as `read`; verify: sidebar updates without reload,
  guest can view but not send.
- Remove one share, delete the token — verify guest is booted.

Documented as a manual runbook first; automate later if worth it.

## Comments

## Answer
