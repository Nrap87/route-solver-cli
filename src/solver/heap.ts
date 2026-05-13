export class MinHeap<T> {
  private items: Array<[number, T]> = []

  push(priority: number, item: T): void {
    this.items.push([priority, item])
    this.bubbleUp(this.items.length - 1)
  }

  pop(): [number, T] | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop()!
    if (this.items.length > 0) {
      this.items[0] = last
      this.sinkDown(0)
    }
    return top
  }

  get size(): number { return this.items.length }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[parent][0] <= this.items[i][0]) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }

  private sinkDown(i: number): void {
    const n = this.items.length
    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2
      if (left < n && this.items[left][0] < this.items[smallest][0]) smallest = left
      if (right < n && this.items[right][0] < this.items[smallest][0]) smallest = right
      if (smallest === i) break
      ;[this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]]
      i = smallest
    }
  }
}
