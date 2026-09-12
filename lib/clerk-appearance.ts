import type { SignIn } from "@clerk/nextjs";
import type { ComponentProps } from "react";

export const clerkAppearance: NonNullable<ComponentProps<typeof SignIn>["appearance"]> = {
  variables: {
    colorPrimary: "#4f46e5",
    colorTextOnPrimaryBackground: "#ffffff",
    borderRadius: "0.85rem",
    fontFamily: "inherit",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "w-full border-0 bg-transparent p-0 shadow-none",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    socialButtonsBlockButton:
      "border-line bg-surface text-foreground hover:bg-surface-muted",
    footer: "bg-transparent",
    footerAction: "text-muted",
    footerActionLink: "text-indigo-600 dark:text-indigo-400",
    footerPages: "hidden",
    badge: "hidden",
    formButtonPrimary: "bg-indigo-600 hover:bg-indigo-500",
    formFieldInput: "border-line bg-surface text-foreground",
  },
};
