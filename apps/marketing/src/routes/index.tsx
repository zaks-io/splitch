import { createFileRoute } from "@tanstack/react-router";
import { CtaSection } from "../components/cta-section";
import { FeatureSection } from "../components/feature-section";
import { HeroSection } from "../components/hero-section";
import { QuickstartSection } from "../components/quickstart-section";
import { RigorSection } from "../components/rigor-section";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <main>
      <HeroSection />
      <FeatureSection />
      <RigorSection />
      <QuickstartSection />
      <CtaSection />
    </main>
  );
}
