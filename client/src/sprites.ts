// sprites.js: сховище завантажених картинок і функція малювання.
// Сюди main.js покладе картинки після завантаження: sprites.hero, sprites.asteroid.
// export const sprites = {} це порожня "полиця", яку заповнять пізніше.
export type SpriteImage = HTMLImageElement | ImageBitmap;
export const sprites: Record<string, SpriteImage | undefined> = {};

// drawSprite малює картинку з центром у точці (x, y).
//   ctx       пензлик canvas
//   img       картинка (з sprites)
//   width,height   розмір на екрані
//   rotation  кут повороту в радіанах (за замовчуванням 0)
//   frame     необов'язково: { x, y, w, h }, тобто вирізати з картинки
//             лише прямокутник. Так працює спрайтшит: одна велика
//             картинка з багатьма кадрами.
export interface SpriteFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  img: SpriteImage,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
  frame: SpriteFrame | null = null,
): void {
  // save/restore: запам'ятовуємо стан пензлика й повертаємо назад.
  ctx.save();

  // translate: зсуваємо початок координат у центр спрайта.
  ctx.translate(x, y);

  // rotate: обертаємо все подальше малювання навколо цієї точки.
  ctx.rotate(rotation);

  if (frame) {
    // 9 аргументів drawImage: (картинка, що вирізати: sx, sy, sw, sh,
    // куди й якого розміру вставити: dx, dy, dw, dh).
    // -width / 2 і -height / 2 дають центрування картинки.
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, -width / 2, -height / 2, width, height);
  } else {
    // Без frame малюємо картинку цілком.
    ctx.drawImage(img, -width / 2, -height / 2, width, height);
  }

  ctx.restore();
}
