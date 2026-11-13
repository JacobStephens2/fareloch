# 0002 - Guest Recipe storage commits one atomic snapshot

Status: accepted (2026-11-13)

## Decision

`src/local-db.ts` owns Guest Recipe storage behind the existing Promise-based Recipe interface. Each operation loads fresh state. Each mutation stages a detached complete result and replaces `guest_recipe_state` with one `localStorage.setItem` call. That replacement is the commit point; failures before it leave committed Recipe state and allocation unchanged. There is no mutable snapshot cache.

The version 1 record contains:

```text
version: 1
recipes: Recipe metadata in insertion order
ingredients: occurrence arrays indexed by Recipe identity
nextId: next positive safe-integer Recipe or occurrence identity
```

Recipe metadata, ingredient snapshots and nutrition construction stay private to the existing guest persistence module. Meal logging uses a synchronous internal query for the Recipe name and scaled, unrounded Macros, then applies Stored rounding as before. Recipe presentation applies Display rounding. The import-free Nutrition module stays at `server/src/nutrition.ts`, as accepted in ADR 0001.

## Legacy promotion and identities

When the canonical record is absent, reads load `guest_recipes` and `guest_recipe_ingredients`, with missing keys treated as empty. Reads do not write. The first successful mutation commits the entire legacy state and its change together. Only after that commit does best-effort cleanup remove the old Recipe keys; cleanup failure cannot reject an already committed operation.

Existing Recipe and occurrence identities and Meal-to-Recipe links survive promotion. A Recipe-scoped counter starts at least at the valid legacy `guest_next_id` and above all existing Recipe identities, occurrence identities and numeric occurrence-map Recipe keys, including orphan entries. Only staged allocation advances it. Replacement and deletion never lower it, and allocation rejects before exceeding safe-integer capacity. Foods, Meals and Weight retain their existing shared counter; numeric overlap between collections is valid because lookups are collection-scoped.

A present canonical record takes precedence even when empty. Unsupported versions, malformed collection data and invalid identity/counter invariants reject without overwriting the record or falling back to stale legacy data. Malformed legacy data also rejects rather than being replaced by an empty fallback. Valid legacy field values are retained without retroactive normalization, including zero or missing ingredient servings and zero quantity or empty Unit labels on copy.

## Consequences

- One storage replacement makes creation, update, duplication and deletion atomic within the existing single-document execution model. Read, parse, staging, serialization and commit errors reject through the existing operation Promises.
- The full snapshot is serialized for each mutation. Promotion can temporarily require quota for both formats. A quota failure preserves legacy data for reads and retry; deleting legacy keys before durable replacement would lose that guarantee.
- Atomic replacement provides no cross-tab serialization. Concurrent tabs can overwrite each other's snapshots. No locking, merge policy, repair screen or compatibility with an older app writing only legacy keys is promised.
- Clearing guest data removes the canonical record, both legacy Recipe keys and the existing unrelated guest collections. Signed-in Recipe persistence remains owned by the server.
- Public guest Recipe tests use real jsdom Storage, storage-boundary faults and Foods seeded through the public Food interface. They cover rejected mutations and retries, promotion, identity preservation/allocation, legacy precedence, invalid records, Meal logging and reset behavior; existing guest editor and Nutrition checks retain their coverage.
