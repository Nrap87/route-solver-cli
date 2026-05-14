export class MinHeap<T> {
  private priorities: number[] = []
  private values: T[] = []

  push(priority: number, item: T): void {
    let i = this.priorities.length

    this.priorities.push(priority)
    this.values.push(item)

    while (i > 0) {
      const parent = (i - 1) >> 1

      if (this.priorities[parent] <= this.priorities[i]) break

      const tp = this.priorities[parent]
      this.priorities[parent] = this.priorities[i]
      this.priorities[i] = tp

      const tv = this.values[parent]
      this.values[parent] = this.values[i]
      this.values[i] = tv

      i = parent
    }
  }

  pop(): [number, T] | undefined {
    const size = this.priorities.length

    if (size === 0) return undefined

    const topPriority = this.priorities[0]
    const topValue = this.values[0]

    const lastPriority = this.priorities.pop()!
    const lastValue = this.values.pop()!

    if (size > 1) {
      this.priorities[0] = lastPriority
      this.values[0] = lastValue

      this.sinkDown(0)
    }

    return [topPriority, topValue]
  }

  get size(): number {
    return this.priorities.length
  }

  private sinkDown(i: number): void {
    const n = this.priorities.length

    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2

      if (
        left < n &&
        this.priorities[left] < this.priorities[smallest]
      ) {
        smallest = left
      }

      if (
        right < n &&
        this.priorities[right] < this.priorities[smallest]
      ) {
        smallest = right
      }

      if (smallest === i) break

      const tp = this.priorities[smallest]
      this.priorities[smallest] = this.priorities[i]
      this.priorities[i] = tp

      const tv = this.values[smallest]
      this.values[smallest] = this.values[i]
      this.values[i] = tv

      i = smallest
    }
  }
}