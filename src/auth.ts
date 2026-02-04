import NextAuth from "next-auth";
import Email from "next-auth/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";

// Provide safe fallbacks so NextAuth doesn't crash during build
const emailFrom = process.env.EMAIL_FROM ?? "no-reply@example.com";

// If you haven't configured SMTP in Vercel yet, this points to a dummy local SMTP.
// It won't be used unless you try to sign in, but it prevents build-time crashes.
const emailServer =
  process.env.EMAIL_SERVER_HOST && process.env.EMAIL_SERVER_PORT
    ? {
        host: process.env.EMAIL_SERVER_HOST,
        port: Number(process.env.EMAIL_SERVER_PORT),
        auth:
          process.env.EMAIL_SERVER_USER && process.env.EMAIL_SERVER_PASSWORD
            ? { user: process.env.EMAIL_SERVER_USER, pass: process.env.EMAIL_SERVER_PASSWORD }
            : undefined,
      }
    : "smtp://localhost:1025";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    Email({
      server: emailServer,
      from: emailFrom,
    }),
  ],
  session: { strategy: "database" },
  pages: {
    signIn: "/signin",
    verifyRequest: "/verify",
  },
  callbacks: {
    async session({ session, user }) {
      (session.user as any).id = user.id;
      return session;
    },
  },
  secret: process.env.AUTH_SECRET,
});
