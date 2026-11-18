// Вектор з незмінними координатами: методи створюють новий результат.
export class Vector2 {
  constructor(
    public readonly x = 0,
    public readonly y = 0,
  ) {}

  add(other: Vector2): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  sub(other: Vector2): Vector2 {
    return new Vector2(this.x - other.x, this.y - other.y);
  }

  scale(amount: number): Vector2 {
    return new Vector2(this.x * amount, this.y * amount);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  magnitude(): number {
    return this.length();
  }

  normalize(): Vector2 {
    const size = this.length();
    return size === 0 ? new Vector2() : this.scale(1 / size);
  }

  rotate(angle: number): Vector2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  dot(other: Vector2): number {
    return this.x * other.x + this.y * other.y;
  }

  dist(other: Vector2): number {
    return this.sub(other).length();
  }

  static fromAngle(angle: number): Vector2 {
    return new Vector2(Math.cos(angle), Math.sin(angle));
  }
}
