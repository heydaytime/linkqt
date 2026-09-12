import { auth } from "@clerk/nextjs/server";
import { LandingStudio } from "./landing-studio";

export default async function Home() {
  const { isAuthenticated } = await auth();
  return <LandingStudio signedIn={Boolean(isAuthenticated)} />;
}
