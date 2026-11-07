import { setRequestLocale } from "next-intl/server";
import { LandingPage } from "@/components/landing/landing-page";
import { landingMetadata } from "@/components/landing/seo";

export const generateMetadata = () => landingMetadata("hi");

export default function HindiHome() {
  setRequestLocale("hi");
  return <LandingPage locale="hi" />;
}
