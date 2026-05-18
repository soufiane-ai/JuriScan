// JuriScan — Supabase Edge Function v2
// Agentic analysis: Claude uses tool_use to flag each legal mention one by one

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FREE_LIMIT = 10;
const MAX_RETRIES = 2;
const MAX_TOOL_TURNS = 25;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un expert en droit commercial français spécialisé dans la facturation.

Pour chaque document reçu :
1. Appelle flag_mention() pour chacune des 13 mentions obligatoires selon l'Art. L441-9 du Code de Commerce :
   - Date d'émission de la facture
   - Numéro de facture unique et séquentiel
   - Nom et adresse du vendeur/prestataire
   - SIRET du vendeur (14 chiffres)
   - Numéro TVA intracommunautaire (ou mention "TVA non applicable art. 293B du CGI")
   - Nom et adresse du client
   - Description précise des produits/services
   - Prix unitaire HT et quantités
   - Taux de TVA applicable et montant TVA
   - Total HT et Total TTC
   - Délai de paiement / date d'échéance
   - Taux des pénalités de retard
   - Indemnité forfaitaire de recouvrement (40€)

2. Appelle finalize() une seule fois, après avoir vérifié toutes les mentions.

Appelle flag_mention() pour CHAQUE mention, qu'elle soit présente ou absente.`;

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "flag_mention",
    description: "Signale une mention légale obligatoire — présente ou absente dans le document",
    input_schema: {
      type: "object",
      properties: {
        mention: { type: "string", description: "Nom de la mention (ex: SIRET, TVA intracommunautaire)" },
        present: { type: "boolean", description: "true si la mention est présente dans le document" },
        detail: { type: "string", description: "Valeur trouvée si présente, ou raison de l'absence si manquante" },
      },
      required: ["mention", "present", "detail"],
    },
  },
  {
    name: "finalize",
    description: "Finalise l'analyse avec le score de conformité global",
    input_schema: {
      type: "object",
      properties: {
        is_invoice: { type: "boolean" },
        document_type: { type: "string", enum: ["facture", "devis", "contrat", "autre"] },
        score: { type: "number", description: "Score de conformité de 0 à 100" },
        status: { type: "string", enum: ["conforme", "attention", "non_conforme"] },
        summary: { type: "string", description: "Résumé court en une phrase" },
        relance_email: { type: "string", description: "Email de relance si facture impayée probable, sinon chaîne vide" },
      },
      required: ["is_invoice", "document_type", "score", "status", "summary", "relance_email"],
    },
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalysisResult {
  is_invoice: boolean;
  document_type: string;
  compliance_score: number;
  status: string;
  missing: string[];
  present: string[];
  summary: string;
  relance_email: string;
}

interface ClaudeBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeResponse {
  stop_reason: string;
  content: ClaudeBlock[];
}

// ─── Langsmith tracer ─────────────────────────────────────────────────────────

async function traceLangsmith(runId: string, payload: {
  name: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  startTime: number;
  endTime?: number;
}) {
  const apiKey = Deno.env.get("LANGSMITH_API_KEY");
  if (!apiKey) return;

  try {
    const lsRes = await fetch("https://eu.api.smith.langchain.com/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        id: runId,
        name: payload.name,
        run_type: "chain",
        inputs: payload.inputs,
        outputs: payload.outputs,
        error: payload.error,
        start_time: new Date(payload.startTime).toISOString(),
        end_time: new Date(payload.endTime ?? Date.now()).toISOString(),
        session_name: "juriscan",
      }),
    });
    console.log(`[langsmith] status=${lsRes.status}`);
  } catch (e) {
    console.log(`[langsmith] error=${(e as Error).message}`);
  }
}

// ─── Claude fetch with retry ──────────────────────────────────────────────────

async function fetchClaude(anthropicKey: string, body: unknown, attempt = 0): Promise<ClaudeResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if ((res.status === 500 || res.status === 529) && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    return fetchClaude(anthropicKey, body, attempt + 1);
  }

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `Erreur Claude API (${res.status})`);
  }

  return res.json();
}

// ─── Agentic analysis loop ────────────────────────────────────────────────────

async function runAnalysisAgent(anthropicKey: string, initialMessages: unknown[]): Promise<AnalysisResult> {
  const present: string[] = [];
  const missing: string[] = [];
  let finalResult: AnalysisResult | null = null;

  const messages = [...initialMessages];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const data = await fetchClaude(anthropicKey, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: data.content });
    console.log(`[agent] turn=${turn} stop_reason=${data.stop_reason} blocks=${data.content.length}`);

    if (data.stop_reason === "end_turn") break;

    if (data.stop_reason === "tool_use") {
      const toolResults: Array<{ type: string; tool_use_id: string | undefined; content: string }> = [];

      for (const block of data.content) {
        if (block.type !== "tool_use") continue;

        if (block.name === "flag_mention") {
          const { mention, present: isPresent, detail } = block.input as { mention: string; present: boolean; detail: string };
          if (isPresent) {
            present.push(`${mention} — ${detail}`);
          } else {
            missing.push(mention);
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "ok" });

        } else if (block.name === "finalize") {
          const inp = block.input as { is_invoice: boolean; document_type: string; score: number; status: string; summary: string; relance_email: string };
          finalResult = {
            is_invoice: inp.is_invoice,
            document_type: inp.document_type,
            compliance_score: inp.score,
            status: inp.status,
            missing,
            present,
            summary: inp.summary,
            relance_email: inp.relance_email || "",
          };
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Analyse finalisée." });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    if (finalResult) break;
  }

  if (!finalResult) throw new Error("L'agent n'a pas finalisé l'analyse");
  return finalResult;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Non autorisé");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const admin = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) throw new Error("Token invalide");
    console.log(`[analyze] user=${user.id}`);

    // Get or create profile
    let { data: profile } = await admin.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) {
      const { data: newProfile } = await admin.from("profiles").insert({ id: user.id }).select().single();
      profile = newProfile;
    }

    // Reset monthly counter if needed
    const resetDate = new Date(profile.scans_reset_at);
    const now = new Date();
    if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
      await admin.from("profiles").update({ scans_used: 0, scans_reset_at: now.toISOString() }).eq("id", user.id);
      profile.scans_used = 0;
    }

    // Check quota
    const limit = profile.plan === "pro" ? 999999 : FREE_LIMIT;
    if (profile.scans_used >= limit) {
      return new Response(
        JSON.stringify({ error: "quota_exceeded", scans_used: profile.scans_used, limit, plan: profile.plan }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { type, content } = await req.json();
    if (!content) throw new Error("Contenu manquant");

    const messages = type === "image"
      ? [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: content } },
          { type: "text", text: "Analyse ce document." },
        ]}]
      : [{ role: "user", content: `TEXTE À ANALYSER :\n---\n${content.slice(0, 5000)}\n---` }];

    const runId = crypto.randomUUID();
    const startTime = Date.now();
    let result: AnalysisResult;

    try {
      result = await runAnalysisAgent(anthropicKey, messages);
      console.log(`[analyze] agent OK score=${result.compliance_score} missing=${result.missing.length}`);
      await traceLangsmith(runId, {
        name: "juriscan-analyze",
        inputs: { type, content_length: content.length },
        outputs: { score: result.compliance_score, status: result.status, missing_count: result.missing.length },
        startTime,
        endTime: Date.now(),
      });
    } catch (e) {
      await traceLangsmith(runId, {
        name: "juriscan-analyze",
        inputs: { type, content_length: content.length },
        error: (e as Error).message,
        startTime,
        endTime: Date.now(),
      });
      throw e;
    }

    await Promise.all([
      admin.from("profiles").update({ scans_used: profile.scans_used + 1 }).eq("id", user.id),
      admin.from("scan_history").insert({
        user_id: user.id,
        document_type: result.document_type,
        compliance_score: result.compliance_score,
        status: result.status,
        missing: result.missing,
        summary: result.summary,
        scan_type: type,
      }),
    ]);

    return new Response(
      JSON.stringify({ ...result, scans_used: profile.scans_used + 1, scans_limit: limit, plan: profile.plan }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
