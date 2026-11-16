import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "./home-carousel.css";

export type HomeCarouselSlide = {
  id: string;
  image?: string;
  eyebrow?: string;
  title: string;
  description: string;
};

export function HomeCarousel({ slides }: { slides: HomeCarouselSlide[] }) {
  const [selected, setSelected] = useState(() => (slides.length > 1 ? 1 : 0));
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const carouselRef = useRef<HTMLElement>(null);
  const carouselId = useId();
  const count = slides.length;
  const active = Math.min(selected, Math.max(0, count - 1));

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setPageHidden(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (
      count < 2 ||
      hovered ||
      focused ||
      pageHidden ||
      typeof window === "undefined"
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => setSelected((active + 1) % count),
      5000,
    );
    return () => window.clearTimeout(timer);
  }, [active, count, hovered, focused, pageHidden]);

  const select = (index: number) => {
    if (count) setSelected(((index % count) + count) % count);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (count < 2 || event.altKey || event.ctrlKey || event.metaKey) return;
    const destination = {
      ArrowLeft: active - 1,
      ArrowRight: active + 1,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (destination === undefined) return;
    event.preventDefault();
    select(destination);
  };

  if (!count) return null;

  return (
    <section
      ref={carouselRef}
      className="home-carousel"
      aria-label="创作灵感"
      aria-roledescription="轮播"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <div className="home-carousel-stage" id={carouselId}>
        {slides.map((slide, index) => {
          let offset = (index - active + count) % count;
          if (offset > count / 2) offset -= count;
          const isActive = index === active;
          const isVisible = Math.abs(offset) <= 1;
          const position = isActive
            ? "active"
            : offset < 0
              ? "previous"
              : "next";
          return (
            <article
              className={`home-carousel-card home-carousel-card--${position} home-carousel-tone-${index % 4}${isVisible ? "" : " home-carousel-card--hidden"}`}
              key={slide.id}
              id={`${carouselId}-${index}`}
              role="group"
              aria-roledescription="宣传卡片"
              aria-label={isActive ? `${index + 1} / ${count}` : undefined}
              aria-hidden={!isVisible}
            >
              {slide.image && (
                <img
                  className="home-carousel-image"
                  src={slide.image}
                  alt=""
                  draggable={false}
                />
              )}
              <div className="home-carousel-shade" />
              <div className="home-carousel-copy" aria-hidden={!isActive}>
                {slide.eyebrow && (
                  <span className="home-carousel-eyebrow">{slide.eyebrow}</span>
                )}
                <h2>{slide.title}</h2>
                <p>{slide.description}</p>
              </div>
              {!isActive && (
                <button
                  className="home-carousel-select"
                  aria-label={`查看第 ${index + 1} 张：${slide.title.replace(/\n/g, " ")}`}
                  tabIndex={isVisible ? 0 : -1}
                  onClick={() => {
                    carouselRef.current?.focus({ preventScroll: true });
                    select(index);
                  }}
                />
              )}
            </article>
          );
        })}
        {count > 1 && (
          <>
            <button
              className="home-carousel-arrow home-carousel-arrow--previous"
              aria-label="上一张宣传卡片"
              aria-controls={carouselId}
              onClick={() => select(active - 1)}
            >
              <ChevronLeft size={22} strokeWidth={1.6} />
            </button>
            <button
              className="home-carousel-arrow home-carousel-arrow--next"
              aria-label="下一张宣传卡片"
              aria-controls={carouselId}
              onClick={() => select(active + 1)}
            >
              <ChevronRight size={22} strokeWidth={1.6} />
            </button>
          </>
        )}
      </div>
      {count > 1 && (
        <div className="home-carousel-pagination" aria-label="选择宣传卡片">
          {slides.map((slide, index) => (
            <button
              className={`home-carousel-dot${index === active ? " home-carousel-dot--active" : ""}`}
              key={slide.id}
              aria-label={`第 ${index + 1} 张：${slide.title.replace(/\n/g, " ")}`}
              aria-current={index === active ? "true" : undefined}
              aria-controls={`${carouselId}-${index}`}
              onClick={() => select(index)}
            >
              <span />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
