import { EXTERNAL_ID_PATHS } from "../core/entities.js";
export * from "../core/entities.js";

export const STATE_EXTERNAL_ID_PATHS = {
  ...EXTERNAL_ID_PATHS,
  openstates_person: '$."openstates_person"',
} as const;

export type StateExternalIdSource = keyof typeof STATE_EXTERNAL_ID_PATHS;
