import gsap from "https://cdn.skypack.dev/gsap";

gsap.defaults({ duration: 0.55, ease: "expo.out" });

// hover-follow reveal for service items
const items = document.querySelectorAll(".service-item");

items.forEach((item) => {
  const imageWrapper = item.querySelector(".service-item-image-wrapper");
  const imageWrapperBounds = imageWrapper.getBoundingClientRect();
  let itemBounds = item.getBoundingClientRect();

  // enter/leave tweens
  const onMouseEnter = () => {
    gsap.set(imageWrapper, {
      scale: 0.8,
      xPercent: 25,
      yPercent: 50,
      rotation: -15,
    });
    gsap.to(imageWrapper, { opacity: 1, scale: 1, yPercent: 0, rotation: 0 });
  };

  const onMouseLeave = () => {
    gsap.to(imageWrapper, {
      opacity: 0,
      yPercent: -50,
      xPercent: 25,
      scale: 0.8,
      rotation: -15,
    });
  };

  // follow cursor
  const onMouseMove = ({ clientX, clientY }) => {
    gsap.to(imageWrapper, {
      duration: 1.25,
      x: clientX - imageWrapperBounds.width / 2,
      y: clientY - imageWrapperBounds.height / 2,
    });
  };

  // bind events
  item.addEventListener("mouseenter", onMouseEnter);
  item.addEventListener("mouseleave", onMouseLeave);
  item.addEventListener("mousemove", onMouseMove);

  // cache bounds on resize
  window.addEventListener("resize", () => {
    itemBounds = item.getBoundingClientRect();
  });
});
