// audio.js слухає шину подій і відтворює звуки.
// Він імпортує bus, а гра (world, entities) НЕ імпортує audio.js.
import { bus } from '../events.js';

// ctx це AudioContext (звуковий рушій), buffers це завантажені
// звуки: { shoot: AudioBuffer, explosion: AudioBuffer }.
export function initAudio(ctx, buffers) {
  // Функція відтворення одного звуку за іменем.
  function play(name, volume = 1) {
    // Браузер не дозволяє звук, поки гравець нічого не натиснув.
    // Тому на кожному відтворенні "будимо" контекст, якщо він спить.
    if (ctx.state === 'suspended') ctx.resume();

    // Беремо потрібний звук. Якщо його немає, мовчки виходимо.
    const buffer = buffers[name];
    if (!buffer) return;

    // BufferSource це "одноразовий програвач": для кожного пострілу
    // створюємо новий, тому звуки можуть накладатися один на одного.
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // GainNode це регулятор гучності.
    const gain = ctx.createGain();
    gain.gain.value = volume;

    // Ланцюжок: програвач -> гучність -> динаміки (ctx.destination).
    source.connect(gain);
    gain.connect(ctx.destination);

    // Запускаємо відтворення.
    source.start();
  }

  // Підписки на події. Стрілка () => ... це функція-обробник.
  bus.addEventListener('fired', () => play('shoot', 0.5));
  bus.addEventListener('hit', () => play('explosion', 0.3)); // окремого звуку hit немає
  bus.addEventListener('exploded', () => play('explosion', 0.8));
}