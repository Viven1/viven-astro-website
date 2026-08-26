// Todo email que sale, anotado en la ficha de la persona.
//
// Sebastián, 26 ago 2026: "todos los emails siempre dentro de la persona, si este email
// salió no se ve". Lo dijo después de que el portal le mandara un código a un cliente
// real y en la ficha de esa persona no quedara ni una línea. Un email que sale sin
// rastro es un email que no existe: al día siguiente nadie sabe qué se le dijo.
//
// Medido ese día: de las 22 funciones que mandan email, solo 4 registraban.
//
// `registrarEmail()` NO manda nada — solo deja el rastro. Se llama DESPUÉS del envío y
// nunca hace fallar al que la llama: si el registro se cae, el email ya salió y lo que
// importa es no romper el flujo. Pero se loguea, para que el hueco se vea en los logs.

/* El cliente de supabase-js tipado en serio pelea con cualquier firma que uno escriba
   (los builders no son Promises hasta que se los await-ea). Acá alcanza con "algo que
   tiene .from": lo que importa es que el llamador pase el cliente de service role. */
// deno-lint-ignore no-explicit-any
type Cliente = { from: (t: string) => any };

export type RegistroEmail = {
  service: Cliente;
  to: string;
  subject: string;
  /** El cuerpo tal cual: si solo hay HTML, se manda el HTML — mejor eso que nada. */
  body: string;
  /** De dónde salió: el nombre de la función. Sale en la timeline de la ficha. */
  source: string;
  /** 'Sofia' | 'Sebastian' | 'VIVEN' — quién lo firma. */
  senderLabel?: string;
  /** Si ya lo sabés, pasalo. Si no, se busca por el email del destinatario. */
  leadId?: string | number | null;
};

export async function registrarEmail(r: RegistroEmail): Promise<void> {
  try {
    let lead_id = r.leadId != null ? String(r.leadId) : null;
    if (!lead_id && r.to) {
      /* Se busca por email, igual que calc-email: sin esto el registro queda huérfano y
         no aparece en la ficha de nadie, que es justo el problema que esto resuelve. */
      const { data } = await r.service.from("leads")
        .select("id").ilike("email", r.to)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data?.id != null) lead_id = String(data.id);
    }
    const { error } = await r.service.from("email_log").insert({
      lead_id,                       // la columna es text y leads.id es bigint
      to_addr: r.to,
      subject: r.subject,
      body: r.body,
      sender_label: r.senderLabel ?? "VIVEN",
      source: r.source,
      direction: "out",
    });
    if (error) console.error("EMAIL_LOG_ERROR", r.source, JSON.stringify(error));
  } catch (e) {
    console.error("EMAIL_LOG_THREW", r.source, String(e));
  }
}
