// ============================================================
// /signup
//
// A server component purely so `SIGNUP_REQUIRES_INVITE` is read at
// REQUEST time. Set it and this deployment stops handing a fresh,
// empty business account to anyone who finds the page — which is how
// two ghost accounts appeared on the live deployment, both belonging
// to people who meant to accept an invite and pressed Sign up
// instead.
//
// Unset — the default — nothing changes. A fresh install still needs
// one open signup to create its first account, and a fork that never
// sets this keeps the behaviour it shipped with.
// ============================================================

import { Suspense } from "react";
import { connection } from "next/server";

import { SignupView } from "./signup-view";

export default async function SignupPage() {
  // Stop prerendering here, so the environment variable below is read
  // per REQUEST and not baked into a build artefact. Without this the
  // page prerenders static and the flag freezes at whatever it was
  // when the site was last built — an operator who sets it and
  // restarts would find the front door still open, with nothing to
  // explain why.
  //
  // `connection()` rather than `export const dynamic`: this version's
  // docs call that the previous way and prefer this, because it ties
  // the dynamic boundary to the incoming request rather than to the
  // whole segment.
  await connection();

  // `useSearchParams` inside SignupView opts it out of static
  // prerendering unless wrapped — same pattern as /login.
  return (
    <Suspense fallback={null}>
      <SignupView
        requireInvite={process.env.SIGNUP_REQUIRES_INVITE === "true"}
      />
    </Suspense>
  );
}
