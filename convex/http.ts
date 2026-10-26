import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
// Convex Auth's OpenID configuration and JWKS routes (no other HTTP routes).
auth.addHttpRoutes(http);

export default http;
