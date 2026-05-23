import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ASSEMBLYAI_API_KEY não configurada no servidor" }, { status: 500 });
  }

  const required = process.env.APP_PASSWORD;
  if (required) {
    const { password } = await req.json().catch(() => ({ password: "" }));
    if (password !== required) {
      return NextResponse.json({ error: "Senha incorreta" }, { status: 401 });
    }
  }

  return NextResponse.json({ apiKey, requiresPassword: !!required });
}

export async function GET() {
  return NextResponse.json({ requiresPassword: !!process.env.APP_PASSWORD });
}
