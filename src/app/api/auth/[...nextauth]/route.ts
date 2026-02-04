// Lazy-load auth so Next build doesn't evaluate NextAuth config at build time
export async function GET(req: Request) {
  const { handlers } = await import("@/auth");
  return handlers.GET(req);
}

export async function POST(req: Request) {
  const { handlers } = await import("@/auth");
  return handlers.POST(req);
}
