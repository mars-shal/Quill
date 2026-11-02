// PocketBase schema for Quill.
//
// Applied automatically on startup, so a fresh clone with an empty pb_data
// directory comes up with the right shape. Every rule is scoped to the owning
// user: a document belongs to the user who signed in, and a workspace to the
// users who are members of it. There is no open access, because this is a
// private writing tool, not a public publishing platform.
//
// This collection is a REMOTE REPLICA. The local SQLite database is canonical
// and keeps working with no server at all; the desktop app's `sync_outbox`
// replays local changes here, and conflicts resolve local-wins.
//
// Three things about this file are load-bearing, each found by probing the
// running server rather than assumed:
//
//   1. Fields are plain object literals in a Collection's `fields` array.
//      Passing `new Field(...)` instances there is silently ignored in 0.40 —
//      the collection is created with only its implicit `id`, and any rule that
//      references a dropped field then fails to resolve. Adding a field to an
//      existing collection is the opposite: `fields.add()` requires a `Field`
//      instance and rejects a plain object.
//   2. `users` is a PocketBase built-in (`_pb_users_auth_`), so this extends
//      the existing collection rather than creating one.
//   3. `findCollectionByNameOrId` throws "sql: no rows in result set" for a
//      missing collection, so absence has to be caught, not compared to null.

// `findCollectionByNameOrId` throws when the collection is absent, so a missing
// collection has to be caught rather than compared against null.
function findOrNull(app, name) {
  try {
    return app.findCollectionByNameOrId(name)
  } catch {
    return null
  }
}

migrate(
  (app) => {
    // --- users ------------------------------------------------------------
    // Extend the built-in auth collection with a display name. The password is
    // hashed and stored by PocketBase; it never reaches the desktop app, and
    // the app never holds a user credential of its own.
    const users = findOrNull(app, "users")
    if (!users) throw new Error("the built-in users collection is missing")

    // A user may only ever see themselves. The collection defaults are left
    // alone otherwise, so a future OAuth or MFA option still works.
    users.listRule = "id = @request.auth.id"
    users.viewRule = "id = @request.auth.id"
    users.updateRule = "id = @request.auth.id"
    users.deleteRule = "id = @request.auth.id"

    // --- workspaces -------------------------------------------------------
    // Every user starts with exactly one. It exists so a shared writing space
    // can be added later without a schema migration, and so the local database
    // has something stable to point at.
    let workspace = findOrNull(app, "workspaces")
    if (!workspace) {
      workspace = new Collection({
        name: "workspaces",
        type: "base",
        // On this collection the membership field is `members` itself. A rule
        // reading `workspace.members` would resolve against a field that only
        // exists on `users`, which PocketBase rejects.
        listRule: "members.id = @request.auth.id",
        viewRule: "members.id = @request.auth.id",
        createRule: "@request.auth.id != ''",
        updateRule: "members.id = @request.auth.id",
        deleteRule: "members.id = @request.auth.id",
        fields: [
          { name: "name", type: "text", required: true, min: 1, max: 120 },
          {
            name: "members",
            type: "relation",
            required: true,
            collectionId: users.id,
            maxSelect: 32,
            cascadeDelete: false,
          },
        ],
      })
      app.save(workspace)
    }

    // Close the loop now that `workspaces` exists. The built-in `users`
    // collection already carries `name` and `avatar`, so only the relation is
    // added here.
    if (!users.fields.some((field) => field.name === "workspace")) {
      users.fields.add(
        new Field({
          name: "workspace",
          type: "relation",
          required: false,
          collectionId: workspace.id,
          maxSelect: 1,
          cascadeDelete: true,
        }),
      )
    }
    app.save(users)

    // --- documents --------------------------------------------------------
    // Mirrors the local `documents` table. `local_id` is the desktop app's own
    // UUID, and the unique index is over (local_id, owner). That is what makes
    // the sync idempotent: replaying an outbox row twice cannot create a
    // duplicate, which matters because an outbox is retried on failure.
    if (!findOrNull(app, "documents")) {
      const documents = new Collection({
        name: "documents",
        type: "base",
        listRule: "owner.id = @request.auth.id",
        viewRule: "owner.id = @request.auth.id",
        createRule: "owner.id = @request.auth.id",
        updateRule: "owner.id = @request.auth.id",
        deleteRule: "owner.id = @request.auth.id",
        fields: [
          { name: "local_id", type: "text", required: true, max: 64 },
          { name: "owner", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
          { name: "workspace", type: "relation", required: false, collectionId: workspace.id, maxSelect: 1, cascadeDelete: true },
          { name: "title", type: "text", required: true, max: 500 },
          { name: "kind", type: "text", required: true, max: 80 },
          { name: "collections", type: "json", required: true },
          { name: "status", type: "text", required: true, max: 40 },
          { name: "color", type: "text", required: false, max: 32 },
          { name: "filename", type: "text", required: false, max: 255 },
          { name: "content", type: "text", required: false, max: 2000000 },
          { name: "content_format", type: "text", required: true, max: 20 },
          { name: "schema_version", type: "number", required: true, min: 1 },
          { name: "provenance", type: "text", required: false, max: 80 },
          // Mirrors the local `documents.deleted_at` column rather than a bool.
          // A required bool must be truthy, so `deleted = false` — the normal
          // value for a live document — fails validation, and an optional bool
          // is still rejected when omitted. A nullable timestamp sidesteps that
          // and maps one-to-one onto the local schema.
          { name: "deleted_at", type: "text", required: false, max: 40 },
          { name: "created_at", type: "text", required: true, max: 40 },
          { name: "updated_at", type: "text", required: true, max: 40 },
        ],
        indexes: ["CREATE UNIQUE INDEX `idx_documents_local_id` ON `documents` (`local_id`, `owner`)"],
      })
      app.save(documents)
    }
  },

  (app) => {
    // Reversed in dependency order so nothing is dropped while still
    // referenced. `users` is deliberately left in place: it is PocketBase's own
    // built-in and other systems may already depend on it.
    for (const name of ["documents", "workspaces"]) {
      try {
        app.delete(findOrNull(app, name))
      } catch {
        // Already absent; a partially-applied rollback is not worth failing on.
      }
    }
  },
)
