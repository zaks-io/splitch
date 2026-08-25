# Convex dogfood example

This project mounts the local `@splitch/convex` package against Splitch shared preview. It verifies
installation, webhook-driven configuration sync, query-safe peeks, transactional mutation
evaluation, rollback, secret rotation, Exposure delivery, and uninstall cleanup.

The React app binds `@splitch/convex/react` to the example's public `splitch:reactFlag` Query. Run
`npm run dev` to verify a live reactive Flag read through the installed component.

The linked Convex deployment lives in `.env.local`. Set `SPLITCH_API_KEY` with the Convex CLI before
calling `splitch:install`; the key must address the shared-preview smoke App's `dev` Environment.
