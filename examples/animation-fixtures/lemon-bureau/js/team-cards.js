import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// team member data
const teamMembers = [
  {
    id: "card-1",
    name: "Ren Nakamura",
    img: "/team-cards/team-member-1.jpg",
    alt: "Ren Nakamura",
    description:
      "Art director with a sharp eye and sharper instincts. Sees the grid others miss.",
  },
  {
    id: "card-2",
    name: "Sable Voss",
    img: "/team-cards/team-member-2.jpg",
    alt: "Sable Voss",
    description:
      "Brand strategist and tone setter. Turns vague briefs into something people actually feel.",
  },
  {
    id: "card-3",
    name: "Cleo Marsh",
    img: "/team-cards/team-member-3.jpg",
    alt: "Cleo Marsh",
    description:
      "Visual storyteller obsessed with texture, light, and the space between both.",
  },
  {
    id: "card-4",
    name: "Yori Tanaka",
    img: "/team-cards/team-member-4.jpg",
    alt: "Yori Tanaka",
    description:
      "Motion designer who treats every frame like it is the only one that matters.",
  },
  {
    id: "card-5",
    name: "Maren Cole",
    img: "/team-cards/team-member-5.jpg",
    alt: "Maren Cole",
    description:
      "Creative lead and resident overthinker. Keeps the work honest and the team grounded.",
  },
];

// dom builders
function buildCard(m) {
  const card = document.createElement("div");
  card.className = "card";
  card.id = m.id;
  card.innerHTML = `
    <div class="card-img">
      <img src="${m.img}" alt="${m.alt}" />
    </div>
    <div class="card-content">
      <div class="card-title"><h6>${m.name}</h6></div>
      <div class="card-description"><p>${m.description}</p></div>
    </div>
  `;
  return card;
}

function buildTeam() {
  // desktop section
  const desktopSection = document.createElement("section");
  desktopSection.className = "sticky team-desktop";
  desktopSection.id = "team-desktop";

  const stickyHeader = document.createElement("div");
  stickyHeader.className = "sticky-header";
  stickyHeader.innerHTML = `<h1>Meet The Obsessives</h1>`;
  desktopSection.appendChild(stickyHeader);

  const desktopCards = teamMembers.map((m) => {
    const card = buildCard(m);
    desktopSection.appendChild(card);
    return card;
  });

  // mobile section
  const mobileSection = document.createElement("section");
  mobileSection.className = "team-mobile";

  const mobileHeader = document.createElement("div");
  mobileHeader.className = "mobile-header";
  mobileHeader.innerHTML = `<h1>Minds at Work</h1>`;
  mobileSection.appendChild(mobileHeader);

  teamMembers.forEach((m) => {
    const card = buildCard(m);
    card.id = `m-${m.id}`;
    mobileSection.appendChild(card);
  });

  return { desktopSection, stickyHeader, desktopCards, mobileSection };
}

// animation transforms
const transforms = [
  [
    [10, 50, -10, 10],
    [20, -10, -45, 20],
  ],
  [
    [0, 47.5, -10, 15],
    [-25, 15, -45, 30],
  ],
  [
    [0, 52.5, -10, 5],
    [15, -5, -40, 60],
  ],
  [
    [0, 50, 30, -80],
    [20, -10, 60, 5],
  ],
  [
    [0, 55, -15, 30],
    [25, -15, 60, 95],
  ],
];

function initTeamCards(mountEl) {
  const { desktopSection, stickyHeader, desktopCards, mobileSection } =
    buildTeam();

  // mount sections (css controls visibility)
  mountEl.appendChild(desktopSection);
  mountEl.appendChild(mobileSection);

  const mm = gsap.matchMedia();

  // desktop
  mm.add("(min-width: 1000px)", () => {
    let scrollTriggerInstance = null;

    let stickyHeight = 0;
    let maxTranslate = 0;
    let cardWidth = 325;
    let cardStartX = 25;
    let cardEndX = -650;

    const measure = () => {
      stickyHeight = window.innerHeight * 5;
      const headerWidth = stickyHeader.offsetWidth;
      maxTranslate = Math.max(0, headerWidth - window.innerWidth);

      const viewportWidth = window.innerWidth;

      if (desktopCards.length > 0 && desktopCards[0]) {
        const cardRect = desktopCards[0].getBoundingClientRect();
        cardWidth = cardRect.width || 325;
      }

      const standardViewportWidth = 1920;
      const standardTravelPixels = Math.abs((-650 / 100) * cardWidth);
      const viewportScale = viewportWidth / standardViewportWidth;
      const requiredTravelPixels =
        standardTravelPixels * 1.25 * Math.max(1, viewportScale);

      cardStartX = 25;
      cardEndX = -(requiredTravelPixels / cardWidth) * 100;
    };

    measure();

    scrollTriggerInstance = ScrollTrigger.create({
      trigger: desktopSection,
      start: "top top",
      end: () => `+=${stickyHeight}px`,
      invalidateOnRefresh: true,
      pin: true,
      pinSpacing: true,
      onUpdate: (self) => {
        const progress = self.progress;

        gsap.set(stickyHeader, { x: -progress * maxTranslate });

        desktopCards.forEach((card, index) => {
          const delay = index * 0.1125;
          const cardProgress = Math.max(0, Math.min((progress - delay) * 2, 1));

          if (cardProgress > 0) {
            const yPos = transforms[index][0];
            const rotations = transforms[index][1];

            const cardX = gsap.utils.interpolate(
              cardStartX,
              cardEndX,
              cardProgress,
            );

            const yProgress = cardProgress * 3;
            const yIndex = Math.min(Math.floor(yProgress), yPos.length - 2);
            const yInterpolation = yProgress - yIndex;
            const cardY = gsap.utils.interpolate(
              yPos[yIndex],
              yPos[yIndex + 1],
              yInterpolation,
            );
            const cardRotation = gsap.utils.interpolate(
              rotations[yIndex],
              rotations[yIndex + 1],
              yInterpolation,
            );

            gsap.set(card, {
              xPercent: cardX,
              yPercent: cardY,
              rotation: cardRotation,
              opacity: 1,
            });
          } else {
            gsap.set(card, { opacity: 0 });
          }
        });
      },
    });

    const onRefreshInit = () => measure();
    ScrollTrigger.addEventListener("refreshInit", onRefreshInit);

    const handleResize = () => {
      measure();
      ScrollTrigger.refresh();
    };
    window.addEventListener("resize", handleResize, { passive: true });

    ScrollTrigger.refresh();

    return () => {
      if (scrollTriggerInstance) scrollTriggerInstance.kill();
      ScrollTrigger.removeEventListener("refreshInit", onRefreshInit);
      window.removeEventListener("resize", handleResize);
    };
  });

  // mobile
  mm.add("(max-width: 999px)", () => {
    // clear inline styles so css takes full control
    gsap.set(desktopSection, { clearProps: "all" });
    gsap.set(stickyHeader, { clearProps: "all" });
    desktopCards.forEach((card) => {
      if (card) gsap.set(card, { clearProps: "all", opacity: 1 });
    });

    ScrollTrigger.refresh();

    const refreshHandler = () => ScrollTrigger.refresh();
    window.addEventListener("orientationchange", refreshHandler);
    const onLoad = () => ScrollTrigger.refresh();
    window.addEventListener("load", onLoad, { passive: true });

    return () => {
      window.removeEventListener("orientationchange", refreshHandler);
      window.removeEventListener("load", onLoad);
    };
  });
}

// mount
const mountEl = document.getElementById("team-cards");
if (mountEl) initTeamCards(mountEl);
