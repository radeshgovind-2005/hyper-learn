import { ClerkProvider, useAuth } from "@clerk/react";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { App } from "./App.js";
import { AuthPage } from "./pages/AuthPage.js";
import "./styles.css";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/** Clerk's components themed to match the app: Meta blue, Figtree, soft radii. */
const appearance = {
  variables: {
    colorPrimary: "#0064e0",
    colorForeground: "#1c2b33",
    colorMutedForeground: "#65676b",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorBorder: "#ccd0d5",
    fontFamily: "Figtree, system-ui, -apple-system, sans-serif",
    borderRadius: "12px",
  },
};

/** Everything except the sign-in and sign-up pages needs a signed-in person. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <div className="empty">Loading…</div>;
  if (!isSignedIn) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  return children;
}

function Root() {
  const navigate = useNavigate();
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY!}
      appearance={appearance}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/sign-in"
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
    >
      <Routes>
        <Route path="/sign-in/*" element={<AuthPage mode="sign-in" />} />
        <Route path="/sign-up/*" element={<AuthPage mode="sign-up" />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <App />
            </RequireAuth>
          }
        />
      </Routes>
    </ClerkProvider>
  );
}

function MissingKey() {
  return (
    <div className="empty">
      Sign-in isn't configured: set <code>VITE_CLERK_PUBLISHABLE_KEY</code> (Clerk dashboard → API keys) and rebuild.
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {PUBLISHABLE_KEY ? (
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    ) : (
      <MissingKey />
    )}
  </StrictMode>,
);

