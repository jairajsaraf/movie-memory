import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

// Google only (reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET). Database sessions, so sign-out really
// ends the session; Auth.js does not expose the user id on a database session by default, so the
// session callback adds it (D-04).
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [Google],
  session: { strategy: "database" },
  callbacks: {
    // Allow-list: this object is also what GET /api/auth/session sends to the browser, and the
    // database session it is built from carries the raw sessionToken.
    session({ session, user }) {
      return {
        user: { id: user.id, name: user.name, email: user.email, image: user.image },
        expires: session.expires,
      };
    },
  },
});
