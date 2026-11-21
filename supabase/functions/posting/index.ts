// Edge Function entry point. Secrets: ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET. Supabase provides
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to every function.
import { createHandler } from "./handler.ts";
import { PostgrestStore, SupabaseAuth } from "./store.ts";
import { ZernioClient } from "./zernio.ts";
import { PostgrestPlanSource } from "../_shared/plan_source.ts";

const env = (name: string) => Deno.env.get(name) ?? "";

Deno.serve(
  createHandler({
    zernio: new ZernioClient(env("ZERNIO_API_KEY")),
    store: new PostgrestStore(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
    auth: new SupabaseAuth(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")),
    plans: new PostgrestPlanSource(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
    webhookSecret: env("ZERNIO_WEBHOOK_SECRET"),
    log: (entry) => console.log(JSON.stringify(entry)),
  }),
);
