// sprites.js: сховище завантажених картинок і функція малювання.
// Сюди main.js покладе картинки після завантаження: sprites.hero, sprites.asteroid.
// export const sprites = {} це порожня "полиця", яку заповнять пізніше.
export const sprites = {};

// drawSprite малює картинку з центром у точці (x, y).
//   ctx       пензлик canvas
//   img       картинка (з sprites)
//   width,height   розмір на екрані
//   rotation  кут повороту в радіанах (за замовчуванням 0)
//   frame     необов'язково: { x, y, w, h }, тобто вирізати з картинки
//             лише прямокутник. Так працює спрайтшит: одна велика
//             картинка з багатьма кадрами.
export function drawSprite(ctx, img, x, y, width, height, rotation = 0, frame = null) {
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
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h,
                  -width / 2, -height / 2, width, height);
  } else {
    // Без frame малюємо картинку цілком.
    ctx.drawImage(img, -width / 2, -height / 2, width, height);
  }

  ctx.restore();
}