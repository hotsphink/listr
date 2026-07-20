// Version of the *data shape* of synced entities (boards, lists, items).
// Distinct from the sync wire PROTOCOL_VERSION: this tags the format of an
// individual stored record so any reader can tell what shape it is in and
// upcast it to the current shape if needed.
//
// Every entity this client authors is stamped with ENTITY_SCHEMA_VERSION (see
// packages/client/src/db/operations.ts). Records with no `schema_version` field
// predate versioning and are treated as version 1 (the current shape at the
// time versioning was introduced).
//
// Bump this whenever the stored shape of an entity changes, and add the
// corresponding upcast/migration (see memory: project_data_format_versioning).
export const ENTITY_SCHEMA_VERSION = 1;
