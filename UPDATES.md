# Safe update process

Use three environments conceptually:

- **Development** — local code changes and automated tests.
- **Staging** — a private hosted copy using a separate database/volume.
- **Production** — the URL used by the group.

For every gameplay update:

1. Create a branch.
2. Make the engine/UI change.
3. Add or update automated tests for the bug/feature.
4. Run `npm run check && npm test`.
5. Deploy to staging.
6. Use host test bots and the Admin Debug panel for quick regression testing.
7. End the test game so its debug log is persisted.
8. Review the Admin Bug Inbox.
9. Merge to `main` only after staging looks good.

Database schema changes should remain backward-compatible or include explicit migration logic before production deployment. Always take a backup before a schema-changing release.
