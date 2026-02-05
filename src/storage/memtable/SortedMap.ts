/**
 * SortedMap - Red-Black Tree based sorted map implementation
 * 
 * Design: For Java developers, this is similar to TreeMap<K,V>.
 * Uses a Red-Black tree for O(log n) insert, delete, and lookup.
 * Maintains keys in sorted order for efficient range queries.
 * 
 * Why Red-Black Tree?
 * - Balanced BST guarantees O(log n) operations
 * - Better than sorted array for frequent inserts (no shifting)
 * - Standard choice in production KV stores (LevelDB, RocksDB)
 */

enum Color {
  RED = 0,
  BLACK = 1,
}

interface RBNode<V> {
  key: string;
  value: V;
  color: Color;
  left: RBNode<V> | null;
  right: RBNode<V> | null;
  parent: RBNode<V> | null;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class SortedMap<V> {
  private root: RBNode<V> | null = null;
  private count: number = 0;

  /**
   * Get number of entries
   */
  get length(): number {
    return this.count;
  }

  /**
   * Set key-value pair (insert or update)
   * Time complexity: O(log n)
   */
  set(key: string, value: V): void {
    const newNode: RBNode<V> = {
      key,
      value,
      color: Color.RED,
      left: null,
      right: null,
      parent: null,
    };

    if (this.root === null) {
      this.root = newNode;
      this.root.color = Color.BLACK;
      this.count++;
      return;
    }

    // Standard BST insert
    let current = this.root;
    let parent: RBNode<V> | null = null;

    while (current !== null) {
      parent = current;
      const cmp = compareKeys(key, current.key);
      
      if (cmp === 0) {
        // Key exists, update value
        current.value = value;
        return;
      } else if (cmp < 0) {
        current = current.left!;
      } else {
        current = current.right!;
      }
    }

    // Insert new node
    newNode.parent = parent;
    if (parent !== null) {
      if (compareKeys(key, parent.key) < 0) {
        parent.left = newNode;
      } else {
        parent.right = newNode;
      }
    }

    this.count++;
    this.fixInsert(newNode);
  }

  /**
   * Get value for key
   * Time complexity: O(log n)
   */
  get(key: string): V | undefined {
    const node = this.findNode(key);
    return node?.value;
  }

  /**
   * Check if key exists
   * Time complexity: O(log n)
   */
  has(key: string): boolean {
    return this.findNode(key) !== null;
  }

  /**
   * Delete key
   * Time complexity: O(log n)
   */
  delete(key: string): boolean {
    const node = this.findNode(key);
    if (node === null) {
      return false;
    }
    this.deleteNode(node);
    this.count--;
    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.root = null;
    this.count = 0;
  }

  /**
   * Get all entries in sorted order (in-order traversal)
   * Time complexity: O(n)
   * 
   * This is the key operation for LSM tree - provides sorted data
   * for SSTable flushing and range queries.
   */
  entries(): Array<[string, V]> {
    const result: Array<[string, V]> = [];
    this.inOrderTraversal(this.root, result);
    return result;
  }

  /**
   * Get entries in range [startKey, endKey]
   * Time complexity: O(log n + k) where k is number of results
   */
  range(startKey: string, endKey: string): Array<[string, V]> {
    const result: Array<[string, V]> = [];
    this.rangeTraversal(this.root, startKey, endKey, result);
    return result;
  }

  /**
   * Iterator for for-of loops
   */
  *[Symbol.iterator](): Iterator<[string, V]> {
    yield* this.inOrderGenerator(this.root);
  }

  // === Private helper methods ===

  private findNode(key: string): RBNode<V> | null {
    let current = this.root;
    while (current !== null) {
      const cmp = compareKeys(key, current.key);
      if (cmp === 0) {
        return current;
      } else if (cmp < 0) {
        current = current.left;
      } else {
        current = current.right;
      }
    }
    return null;
  }

  private inOrderTraversal(node: RBNode<V> | null, result: Array<[string, V]>): void {
    if (node === null) return;
    this.inOrderTraversal(node.left, result);
    result.push([node.key, node.value]);
    this.inOrderTraversal(node.right, result);
  }

  private *inOrderGenerator(node: RBNode<V> | null): Generator<[string, V]> {
    if (node === null) return;
    yield* this.inOrderGenerator(node.left);
    yield [node.key, node.value];
    yield* this.inOrderGenerator(node.right);
  }

  private rangeTraversal(
    node: RBNode<V> | null, 
    startKey: string, 
    endKey: string, 
    result: Array<[string, V]>
  ): void {
    if (node === null) return;
    
    const cmpStart = compareKeys(node.key, startKey);
    const cmpEnd = compareKeys(node.key, endKey);
    
    // Visit left subtree if there might be keys >= startKey
    if (cmpStart > 0) {
      this.rangeTraversal(node.left, startKey, endKey, result);
    }
    
    // Include this node if in range
    if (cmpStart >= 0 && cmpEnd <= 0) {
      result.push([node.key, node.value]);
    }
    
    // Visit right subtree if there might be keys <= endKey
    if (cmpEnd < 0) {
      this.rangeTraversal(node.right, startKey, endKey, result);
    }
  }

  // === Red-Black Tree balancing operations ===

  private fixInsert(node: RBNode<V>): void {
    let current = node;
    
    while (current !== this.root && current.parent?.color === Color.RED) {
      const parent = current.parent;
      const grandparent = parent.parent;
      
      if (grandparent === null) break;
      
      if (parent === grandparent.left) {
        const uncle = grandparent.right;
        
        if (uncle?.color === Color.RED) {
          // Case 1: Uncle is red
          parent.color = Color.BLACK;
          uncle.color = Color.BLACK;
          grandparent.color = Color.RED;
          current = grandparent;
        } else {
          if (current === parent.right) {
            // Case 2: Node is right child
            current = parent;
            this.rotateLeft(current);
          }
          // Case 3: Node is left child
          current.parent!.color = Color.BLACK;
          current.parent!.parent!.color = Color.RED;
          this.rotateRight(current.parent!.parent!);
        }
      } else {
        const uncle = grandparent.left;
        
        if (uncle?.color === Color.RED) {
          parent.color = Color.BLACK;
          uncle.color = Color.BLACK;
          grandparent.color = Color.RED;
          current = grandparent;
        } else {
          if (current === parent.left) {
            current = parent;
            this.rotateRight(current);
          }
          current.parent!.color = Color.BLACK;
          current.parent!.parent!.color = Color.RED;
          this.rotateLeft(current.parent!.parent!);
        }
      }
    }
    
    this.root!.color = Color.BLACK;
  }

  private rotateLeft(node: RBNode<V>): void {
    const rightChild = node.right;
    if (rightChild === null) return;
    
    node.right = rightChild.left;
    if (rightChild.left !== null) {
      rightChild.left.parent = node;
    }
    
    rightChild.parent = node.parent;
    if (node.parent === null) {
      this.root = rightChild;
    } else if (node === node.parent.left) {
      node.parent.left = rightChild;
    } else {
      node.parent.right = rightChild;
    }
    
    rightChild.left = node;
    node.parent = rightChild;
  }

  private rotateRight(node: RBNode<V>): void {
    const leftChild = node.left;
    if (leftChild === null) return;
    
    node.left = leftChild.right;
    if (leftChild.right !== null) {
      leftChild.right.parent = node;
    }
    
    leftChild.parent = node.parent;
    if (node.parent === null) {
      this.root = leftChild;
    } else if (node === node.parent.right) {
      node.parent.right = leftChild;
    } else {
      node.parent.left = leftChild;
    }
    
    leftChild.right = node;
    node.parent = leftChild;
  }

  private deleteNode(node: RBNode<V>): void {
    let replacementNode: RBNode<V> | null;
    let fixupNode: RBNode<V> | null;
    let fixupParent: RBNode<V> | null;
    let originalColor = node.color;

    if (node.left === null) {
      fixupNode = node.right;
      fixupParent = node.parent;
      this.transplant(node, node.right);
    } else if (node.right === null) {
      fixupNode = node.left;
      fixupParent = node.parent;
      this.transplant(node, node.left);
    } else {
      // Node has two children - find successor
      replacementNode = this.minimum(node.right);
      originalColor = replacementNode.color;
      fixupNode = replacementNode.right;
      
      if (replacementNode.parent === node) {
        fixupParent = replacementNode;
      } else {
        fixupParent = replacementNode.parent;
        this.transplant(replacementNode, replacementNode.right);
        replacementNode.right = node.right;
        replacementNode.right.parent = replacementNode;
      }
      
      this.transplant(node, replacementNode);
      replacementNode.left = node.left;
      replacementNode.left.parent = replacementNode;
      replacementNode.color = node.color;
    }

    if (originalColor === Color.BLACK) {
      this.fixDelete(fixupNode, fixupParent);
    }
  }

  private transplant(u: RBNode<V>, v: RBNode<V> | null): void {
    if (u.parent === null) {
      this.root = v;
    } else if (u === u.parent.left) {
      u.parent.left = v;
    } else {
      u.parent.right = v;
    }
    if (v !== null) {
      v.parent = u.parent;
    }
  }

  private minimum(node: RBNode<V>): RBNode<V> {
    let current = node;
    while (current.left !== null) {
      current = current.left;
    }
    return current;
  }

  private fixDelete(node: RBNode<V> | null, parent: RBNode<V> | null): void {
    while (node !== this.root && (node === null || node.color === Color.BLACK)) {
      if (parent === null) break;
      
      if (node === parent.left) {
        let sibling = parent.right;
        
        if (sibling?.color === Color.RED) {
          sibling.color = Color.BLACK;
          parent.color = Color.RED;
          this.rotateLeft(parent);
          sibling = parent.right;
        }
        
        if (sibling === null) break;
        
        if ((sibling.left === null || sibling.left.color === Color.BLACK) &&
            (sibling.right === null || sibling.right.color === Color.BLACK)) {
          sibling.color = Color.RED;
          node = parent;
          parent = node.parent;
        } else {
          if (sibling.right === null || sibling.right.color === Color.BLACK) {
            if (sibling.left !== null) {
              sibling.left.color = Color.BLACK;
            }
            sibling.color = Color.RED;
            this.rotateRight(sibling);
            sibling = parent.right;
          }
          
          if (sibling !== null) {
            sibling.color = parent.color;
            if (sibling.right !== null) {
              sibling.right.color = Color.BLACK;
            }
          }
          parent.color = Color.BLACK;
          this.rotateLeft(parent);
          node = this.root;
          break;
        }
      } else {
        let sibling = parent.left;
        
        if (sibling?.color === Color.RED) {
          sibling.color = Color.BLACK;
          parent.color = Color.RED;
          this.rotateRight(parent);
          sibling = parent.left;
        }
        
        if (sibling === null) break;
        
        if ((sibling.right === null || sibling.right.color === Color.BLACK) &&
            (sibling.left === null || sibling.left.color === Color.BLACK)) {
          sibling.color = Color.RED;
          node = parent;
          parent = node.parent;
        } else {
          if (sibling.left === null || sibling.left.color === Color.BLACK) {
            if (sibling.right !== null) {
              sibling.right.color = Color.BLACK;
            }
            sibling.color = Color.RED;
            this.rotateLeft(sibling);
            sibling = parent.left;
          }
          
          if (sibling !== null) {
            sibling.color = parent.color;
            if (sibling.left !== null) {
              sibling.left.color = Color.BLACK;
            }
          }
          parent.color = Color.BLACK;
          this.rotateRight(parent);
          node = this.root;
          break;
        }
      }
    }
    
    if (node !== null) {
      node.color = Color.BLACK;
    }
  }
}
