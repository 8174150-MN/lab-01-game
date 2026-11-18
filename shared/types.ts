// Бренд відрізняє значення однакової базової форми на етапі перевірки типів.
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

// Ці три числа виглядають однаково під час роботи, але мають різний сенс у коді.
export type EntityId = Brand<string, 'EntityId'>;
export type Tick = Brand<number, 'Tick'>;
export type Seq = Brand<number, 'Seq'>;

// Ці конструктори стоять на межі, де звичайне число чи рядок стає перевіреним ID або лічильником.
export const asEntityId = (value: string): EntityId => value as EntityId; // Бренд не має runtime-представлення, тому тут потрібне вузьке приведення.
export const asTick = (value: number): Tick => value as Tick; // Викликається лише після перевірки числа або читання uint32.
export const asSeq = (value: number): Seq => value as Seq; // Викликається лише після перевірки uint32.

// Кожен варіант сутності має власне kind, за яким TypeScript звужує доступні поля.
export interface ShipEntity {
  readonly kind: 'ship';
  readonly id: EntityId;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly hp: number;
  readonly ackSeq: Seq;
  readonly respawnTicks: number;
  readonly score: number;
}

export interface BulletEntity {
  readonly kind: 'bullet';
  readonly id: EntityId;
  readonly ownerId: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly ttl: number;
  readonly seq?: Seq;
}

export interface AsteroidEntity {
  readonly kind: 'asteroid';
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
  readonly homing: boolean;
}

export interface PickupEntity {
  readonly kind: 'pickup';
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export type SnapshotEntity = ShipEntity | BulletEntity | AsteroidEntity | PickupEntity;

// Команда містить лише керування; координати ніколи не приходять від клієнта.
export interface InputCommand {
  readonly seq: Seq;
  readonly gas: boolean;
  readonly turn: -1 | 0 | 1;
  readonly shoot: boolean;
}

// Стан корабля змінюється фізикою, але його числові поля мають сталу форму.
export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly hp: number;
  readonly score: number;
  readonly respawnTicks: number;
  readonly ackSeq: Seq;
  readonly kind: 'ship';
}

// Знімок містить ті самі сутності окремими масивами для сумісності зі старим рендером гри.
export interface Snapshot {
  readonly v: 1 | 3;
  readonly type: 'snapshot';
  readonly tick: Tick;
  readonly seed: number;
  readonly players: readonly ShipEntity[];
  readonly bullets: readonly BulletEntity[];
  readonly asteroids: readonly AsteroidEntity[];
  readonly pickups: readonly PickupEntity[];
}
