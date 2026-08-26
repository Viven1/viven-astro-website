// Supabase Edge Function: admin-users
//
// Alta, baja, contraseña y rol de las personas que entran al dashboard, sin que
// Sebastián tenga que abrir nunca el panel de Supabase.
//
// POR QUÉ ESTO EXISTE (2026-08-14): el alta de usuarios del proyecto estaba
// ABIERTA (`disable_signup: false`) y la clave publishable está a la vista en el
// JS del dashboard — cualquiera se registraba solo. Cerrar el alta pública es lo
// correcto, pero deja un hueco práctico: sin ella no hay forma de sumar a nadie.
// Esta función es esa forma, y la única: pasa por acá o no pasa.
//
// SEGURIDAD — las tres reglas que no se negocian:
//   1. La service_role key vive SOLO acá adentro. Nunca en el frontend: quien la
//      tiene salta todas las RLS de la base.
//   2. Todo llamado se identifica con el JWT de quien llama y se exige rol
//      `superadmin` en public.user_roles. No alcanza con estar logueado — que es
//      justamente el agujero que estamos tapando.
//   3. Solo direcciones @viven.ch. Un superadmin distraído no puede dar de alta
//      a alguien de afuera ni por error ni por pegar mal un email.
//
// Deploy:  supabase functions deploy admin-users
//          (verify_jwt queda ENCENDIDO — es el default y acá hace falta)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const service = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const DOMINIO = /@viven\.ch$/i;
const ROLES = ["member", "superadmin"];
// 12 y no 8: son cuentas que ven facturas y datos de clientes, y no hay segundo
// factor. El largo es la única defensa que queda contra fuerza bruta.
const MIN_PASS = 12;

const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();

function validarPass(p: unknown): string | null {
  const s = String(p ?? "");
  if (s.length < MIN_PASS) return `La contraseña necesita al menos ${MIN_PASS} caracteres.`;
  if (/^\s|\s$/.test(s)) return "La contraseña no puede empezar ni terminar con espacios (se pega mal desde el gestor).";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ---- 1. quién llama ----------------------------------------------------
    const auth = req.headers.get("Authorization") ?? "";
    const asCaller = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asCaller.auth.getUser();
    if (!user) return json({ error: "No hay sesión." }, 401);

    const yo = norm(user.email);

    // ---- 2. ¿es superadmin? ------------------------------------------------
    // Se pregunta con la service key: si se preguntara con el token de quien
    // llama, la respuesta dependería de las RLS que justamente controlan esto.
    const { data: miRol } = await service
      .from("user_roles").select("role").ilike("email", yo).maybeSingle();
    if (!miRol || miRol.role !== "superadmin") {
      console.warn("ADMIN_USERS_DENEGADO", yo);
      return json({ error: "Solo un superadmin puede administrar usuarios." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const email = norm(body.email);

    // ---- 3. reglas comunes a toda acción con destinatario -------------------
    if (action !== "list") {
      if (!email) return json({ error: "Falta el email." }, 400);
      if (!DOMINIO.test(email)) return json({ error: "Solo direcciones @viven.ch." }, 400);
    }

    // Cuántos superadmins quedan. Se usa para no dejar la casa sin llaves:
    // bajarse el rol a uno mismo siendo el único, o darse de baja, deja el
    // dashboard sin nadie que pueda administrar y se arregla solo entrando al
    // panel de Supabase — que es exactamente lo que esto vino a evitar.
    const contarSuperadmins = async () => {
      const { count } = await service.from("user_roles")
        .select("email", { count: "exact", head: true }).eq("role", "superadmin");
      return count ?? 0;
    };

    switch (action) {
      // ---------------------------------------------------------------------
      case "list": {
        const { data: authUsers, error: e1 } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (e1) return json({ error: e1.message }, 500);
        const { data: roles } = await service.from("user_roles").select("email,role");
        const rolDe = new Map((roles ?? []).map((r) => [norm(r.email), r.role]));

        const users = (authUsers?.users ?? []).map((u) => ({
          email: norm(u.email),
          role: rolDe.get(norm(u.email)) ?? null,   // null = tiene cuenta pero NO está en la lista
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          confirmed: !!u.email_confirmed_at,
          // banned_until viene del admin API; el tipo público no lo declara
          // el tipo User de supabase-js no declara banned_until, pero la API sí lo manda
          disabled: !!(u as unknown as Record<string, unknown>).banned_until,
        })).sort((a, b) => a.email.localeCompare(b.email));

        // Los `role: null` son la señal que importa: si el alta pública estuvo
        // abierta, acá aparecen los colados. Que se vean, no que se filtren.
        return json({ users, colados: users.filter((u) => !u.role).map((u) => u.email) });
      }

      // ---------------------------------------------------------------------
      case "create": {
        const malPass = validarPass(body.password);
        if (malPass) return json({ error: malPass }, 400);
        const role = String(body.role ?? "member");
        if (!ROLES.includes(role)) return json({ error: "Rol inválido." }, 400);

        const { error: e1 } = await service.auth.admin.createUser({
          email,
          password: String(body.password),
          // sin esto le llega un mail de confirmación y no puede entrar hasta
          // hacer clic; la contraseña la elegís vos y se la pasás vos.
          email_confirm: true,
        });
        if (e1) return json({ error: e1.message }, 400);

        const { error: e2 } = await service.from("user_roles").upsert({ email, role }, { onConflict: "email" });
        if (e2) return json({ error: `Usuario creado, pero falló el rol: ${e2.message}` }, 500);

        console.log("ADMIN_USERS_CREATE", yo, "→", email, role);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------------
      case "set_password": {
        const malPass = validarPass(body.password);
        if (malPass) return json({ error: malPass }, 400);

        const { data: u } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
        const target = (u?.users ?? []).find((x) => norm(x.email) === email);
        if (!target) return json({ error: "No existe esa cuenta." }, 404);

        const { error } = await service.auth.admin.updateUserById(target.id, { password: String(body.password) });
        if (error) return json({ error: error.message }, 400);

        console.log("ADMIN_USERS_PASS", yo, "→", email);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------------
      case "set_role": {
        const role = String(body.role ?? "");
        if (!ROLES.includes(role)) return json({ error: "Rol inválido." }, 400);
        if (email === yo && role !== "superadmin" && (await contarSuperadmins()) <= 1) {
          return json({ error: "Sos el único superadmin: nombrá a otro antes de bajarte el rol." }, 400);
        }
        const { error } = await service.from("user_roles").upsert({ email, role }, { onConflict: "email" });
        if (error) return json({ error: error.message }, 500);

        console.log("ADMIN_USERS_ROL", yo, "→", email, role);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------------
      case "disable": {
        if (email === yo) return json({ error: "No podés darte de baja a vos mismo." }, 400);

        const { data: u } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
        const target = (u?.users ?? []).find((x) => norm(x.email) === email);
        if (!target) return json({ error: "No existe esa cuenta." }, 404);

        // Baja en los DOS lados y en este orden. Sacarlo de user_roles es lo que
        // corta el acceso de verdad después de la SQL 0127 (is_member()); el ban
        // del lado de Auth impide además que renueve el token. Si solo se hiciera
        // el ban, un token vigente seguiría entrando hasta vencerse.
        const { error: e1 } = await service.from("user_roles").delete().ilike("email", email);
        if (e1) return json({ error: e1.message }, 500);
        const { error: e2 } = await service.auth.admin.updateUserById(target.id, { ban_duration: "876000h" });
        if (e2) return json({ error: `Sacado de la lista, pero no se pudo bloquear la cuenta: ${e2.message}` }, 500);

        console.log("ADMIN_USERS_BAJA", yo, "→", email);
        return json({ ok: true });
      }

      default:
        return json({ error: `Acción desconocida: ${action}` }, 400);
    }
  } catch (e) {
    console.error("ADMIN_USERS_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
