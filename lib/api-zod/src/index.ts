export * from "./generated/api";
export * from "./generated/types";

// Orval emits a zod schema (generated/api) and a TS type (generated/types)
// under the same name for some inputs; `export *` cannot disambiguate them
// (TS2308), so the type is re-exported explicitly to resolve the name.
export type { UpdateAdminUserRoleBody } from "./generated/types";
