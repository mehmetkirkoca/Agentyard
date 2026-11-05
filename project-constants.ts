import type {Project} from "./types";

// Built-in project holding the project-independent sessions shown in the SESSIONS section.
export const STANDALONE_PROJECT_ID = "__standalone__";
export const STANDALONE_PROJECT_NAME = "Others";

export function isStandaloneProject(project: Pick<Project, "id"> | string | undefined): boolean {
  const id = typeof project === "string" ? project : project?.id;
  return id === STANDALONE_PROJECT_ID;
}
