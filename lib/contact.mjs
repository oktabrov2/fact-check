import crypto from "node:crypto";

function asLine(value, max) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function asMessage(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

export function normaliseContactMessage(input) {
  const name = asLine(input?.name, 120);
  const email = asLine(input?.email, 254).toLowerCase();
  const subject = asLine(input?.subject, 200);
  const message = asMessage(input?.message, 4000);

  if (name.length < 2) throw new Error("Please enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Please enter a valid email address.");
  if (subject.length < 3) throw new Error("Please add a short subject.");
  if (message.length < 12) throw new Error("Please write at least 12 characters in your message.");

  return { name, email, subject, message };
}

export function createContactStore(pool) {
  if (!pool?.query) throw new Error("A PostgreSQL pool is required for contact messages.");

  async function submit(input, { ip = null } = {}) {
    const clean = normaliseContactMessage(input);
    const id = "msg-" + crypto.randomUUID();
    const result = await pool.query(
      "INSERT INTO contact_messages (id, name, email, subject, message, ip) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at",
      [id, clean.name, clean.email, clean.subject, clean.message, ip || null],
    );
    return { id: result.rows[0].id, createdAt: new Date(result.rows[0].created_at).toISOString() };
  }

  async function list(limit = 100) {
    const cappedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await pool.query(
      "SELECT id, name, email, subject, message, ip, created_at FROM contact_messages ORDER BY created_at DESC LIMIT $1",
      [cappedLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      subject: row.subject,
      message: row.message,
      ip: row.ip,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  return { submit, list };
}
