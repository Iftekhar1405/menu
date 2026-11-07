import { setRequestLocale } from "next-intl/server";
import { LandingPage } from "@/components/landing/landing-page";
import { landingMetadata } from "@/components/landing/seo";

export const generateMetadata = () => landingMetadata("en");

export default function Home() {
  setRequestLocale("en");
  return <LandingPage locale="en" />;
}
