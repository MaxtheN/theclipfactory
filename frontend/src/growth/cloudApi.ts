import { api, post } from "../api";

export type CloudStatus = {
  configured: boolean;
  signed_in: boolean;
  email: string | null;
  workspace_id: string | null;
  /** Present when sign-up needs email confirmation or configuration was refused. */
  message?: string;
  confirmation_required?: boolean;
};

export type CloudCredentials = {
  email: string;
  password: string;
  workspace_name?: string;
};

/** All Supabase traffic goes through the local backend; the page never talks to Supabase. */
export const cloudApi = {
  status: () => api<CloudStatus>("/api/cloud/status"),
  signIn: (body: CloudCredentials) =>
    post<CloudStatus>("/api/cloud/sign-in", body),
  signUp: (body: CloudCredentials) =>
    post<CloudStatus>("/api/cloud/sign-up", body),
  signOut: () => post<CloudStatus>("/api/cloud/sign-out"),
};
