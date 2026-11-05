(function () {
  function parseGif(buffer) {
    const bytes = new Uint8Array(buffer);
    let position = 0;

    function readByte() {
      if (position >= bytes.length) throw new Error("Unexpected end of GIF");
      return bytes[position++];
    }

    function readUnsignedShort() {
      const value = readByte() | (readByte() << 8);
      return value;
    }

    function readColorTable(count) {
      const table = new Uint8Array(count * 3);
      for (let index = 0; index < table.length; index++) table[index] = readByte();
      return table;
    }

    function readSubBlocks() {
      const chunks = [];
      let total = 0;
      while (position < bytes.length) {
        const size = readByte();
        if (size === 0) break;
        chunks.push(bytes.subarray(position, position + size));
        total += size;
        position += size;
      }
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return combined;
    }

    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    position = 6;
    if (signature !== "GIF87a" && signature !== "GIF89a") {
      throw new Error("Not a GIF");
    }

    const width = readUnsignedShort();
    const height = readUnsignedShort();
    const packed = readByte();
    const backgroundIndex = readByte();
    readByte();

    const globalColorTable = packed >> 7 ? readColorTable(1 << ((packed & 7) + 1)) : null;
    const frames = [];
    let control = null;

    while (position < bytes.length) {
      const marker = readByte();
      if (marker === 0x3b) break;

      if (marker === 0x21) {
        const label = readByte();
        if (label === 0xf9) {
          readByte();
          const fields = readByte();
          const delay = readUnsignedShort();
          const transparentIndex = readByte();
          readByte();
          control = {
            disposal: (fields >> 2) & 7,
            transparent: fields & 1 ? transparentIndex : null,
            delay: delay,
          };
        } else {
          readSubBlocks();
        }
        continue;
      }

      if (marker !== 0x2c) break;

      const left = readUnsignedShort();
      const top = readUnsignedShort();
      const frameWidth = readUnsignedShort();
      const frameHeight = readUnsignedShort();
      const framePacked = readByte();
      const localColorTable = framePacked >> 7 ? readColorTable(1 << ((framePacked & 7) + 1)) : null;
      const colorTable = localColorTable || globalColorTable;
      if (!colorTable) throw new Error("GIF frame is missing a color table");

      const minCodeSize = readByte();
      const pixels = lzwDecode(minCodeSize, readSubBlocks(), frameWidth * frameHeight);
      const interlaced = (framePacked >> 6) & 1;

      frames.push({
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        pixels: interlaced ? deinterlace(pixels, frameWidth, frameHeight) : pixels,
        colorTable,
        disposal: control ? control.disposal : 1,
        transparent: control ? control.transparent : null,
        delay: frameDelay(control ? control.delay : 10),
      });
      control = null;
    }

    if (!frames.length) throw new Error("GIF has no frames");
    return { width, height, backgroundIndex, globalColorTable, frames };
  }

  // Browsers treat a 0 or 1 centisecond delay as 100ms.
  function frameDelay(centiseconds) {
    if (centiseconds < 2) return 100;
    return centiseconds * 10;
  }

  function deinterlace(pixels, width, height) {
    const output = new Uint8Array(pixels.length);
    const passes = [
      [0, 8],
      [4, 8],
      [2, 4],
      [1, 2],
    ];
    let offset = 0;
    for (const [start, step] of passes) {
      for (let y = start; y < height; y += step) {
        output.set(pixels.subarray(offset, offset + width), y * width);
        offset += width;
      }
    }
    return output;
  }

  function lzwDecode(minCodeSize, data, pixelCount) {
    const maxCode = 4096;
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let available = clearCode + 2;
    let oldCode = -1;
    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;

    const prefix = new Int16Array(maxCode);
    const suffix = new Uint8Array(maxCode);
    const stack = new Uint8Array(maxCode + 1);
    for (let code = 0; code < clearCode; code++) suffix[code] = code;

    const output = new Uint8Array(pixelCount);
    let outIndex = 0;
    let top = 0;
    let datum = 0;
    let bits = 0;
    let byteIndex = 0;
    let first = 0;

    while (outIndex < pixelCount) {
      if (top === 0) {
        if (bits < codeSize) {
          if (byteIndex >= data.length) break;
          datum |= data[byteIndex] << bits;
          bits += 8;
          byteIndex++;
          continue;
        }

        let code = datum & codeMask;
        datum >>>= codeSize;
        bits -= codeSize;

        if (code > available || code === eoiCode) break;

        if (code === clearCode) {
          codeSize = minCodeSize + 1;
          codeMask = (1 << codeSize) - 1;
          available = clearCode + 2;
          oldCode = -1;
          continue;
        }

        if (oldCode === -1) {
          stack[top++] = suffix[code];
          oldCode = code;
          first = code;
          continue;
        }

        let inCode = code;
        if (code === available) {
          stack[top++] = first;
          code = oldCode;
        }

        let guard = 0;
        while (code > clearCode) {
          stack[top++] = suffix[code];
          code = prefix[code];
          if (++guard > maxCode) break;
        }

        first = suffix[code];
        stack[top++] = first;

        if (available < maxCode) {
          prefix[available] = oldCode;
          suffix[available] = first;
          available++;
          if ((available & codeMask) === 0 && available < maxCode) {
            codeSize++;
            codeMask = (1 << codeSize) - 1;
          }
        }
        oldCode = inCode;
      }

      output[outIndex++] = stack[--top];
    }

    return output;
  }

  function composeFrames(gif) {
    const { width, height, frames, backgroundIndex, globalColorTable } = gif;
    const canvas = new Uint8ClampedArray(width * height * 4);
    const composed = [];

    function clearRect(frame) {
      const useBackground = frame.transparent === null && globalColorTable;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const pixel = ((frame.top + y) * width + frame.left + x) * 4;
          if (pixel < 0 || pixel + 3 >= canvas.length) continue;
          if (useBackground) {
            const color = backgroundIndex * 3;
            canvas[pixel] = globalColorTable[color];
            canvas[pixel + 1] = globalColorTable[color + 1];
            canvas[pixel + 2] = globalColorTable[color + 2];
            canvas[pixel + 3] = 255;
          } else {
            canvas[pixel] = 0;
            canvas[pixel + 1] = 0;
            canvas[pixel + 2] = 0;
            canvas[pixel + 3] = 0;
          }
        }
      }
    }

    for (const frame of frames) {
      const before = frame.disposal === 3 ? canvas.slice() : null;
      const table = frame.colorTable;

      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const index = frame.pixels[y * frame.width + x];
          if (index === frame.transparent) continue;
          const destinationX = frame.left + x;
          const destinationY = frame.top + y;
          if (destinationX < 0 || destinationY < 0 || destinationX >= width || destinationY >= height) continue;
          const pixel = (destinationY * width + destinationX) * 4;
          const color = index * 3;
          canvas[pixel] = table[color];
          canvas[pixel + 1] = table[color + 1];
          canvas[pixel + 2] = table[color + 2];
          canvas[pixel + 3] = 255;
        }
      }

      composed.push(canvas.slice());

      if (frame.disposal === 2) clearRect(frame);
      else if (frame.disposal === 3 && before) canvas.set(before);
    }

    return {
      width,
      height,
      frames: composed,
      delays: frames.map(function (frame) {
        return frame.delay;
      }),
    };
  }

  function initHoverGifs() {
    const images = document.querySelectorAll("img.hover-gif");
    if (!images.length) return;

    document.documentElement.classList.add("js");

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canHover = window.matchMedia("(hover: hover)").matches;
    const hint = document.querySelector(".gallery-hint");
    if (hint && (reduceMotion || !canHover)) hint.textContent = "Tap to play.";

    const players = [];

    images.forEach(function (img) {
      prepare(img).catch(function (error) {
        console.error("Could not prepare hover GIF", img.getAttribute("src"), error);
        img.style.opacity = "1";
      });
    });

    function prepare(img) {
      const source = img.getAttribute("src");
      const figure = img.closest("figure");
      const caption = figure ? figure.querySelector("figcaption") : null;
      const label = img.alt || (caption ? caption.textContent.trim() : "") || "Animation";

      return fetch(source)
        .then(function (response) {
          if (!response.ok) throw new Error("Could not load " + source);
          return response.arrayBuffer();
        })
        .then(function (buffer) {
          const clip = composeFrames(parseGif(buffer));
          const button = document.createElement("button");
          button.type = "button";
          button.className = "detail-media";
          button.setAttribute("aria-label", label);
          if (reduceMotion || !canHover) button.setAttribute("aria-pressed", "false");

          const canvas = document.createElement("canvas");
          canvas.className = "detail-canvas";
          canvas.width = clip.width;
          canvas.height = clip.height;
          canvas.setAttribute("aria-hidden", "true");
          button.appendChild(canvas);

          const context = canvas.getContext("2d");
          const bitmap = new ImageData(clip.width, clip.height);
          let frameIndex = 0;
          let timer = 0;
          let playing = false;
          let hovered = false;
          let keyboardFocused = false;
          let pinned = false;
          let pointerType = "mouse";
          let fromPointer = false;
          let onScreen = true;

          function show(index) {
            bitmap.data.set(clip.frames[index]);
            context.putImageData(bitmap, 0, 0);
          }

          function tick() {
            frameIndex = (frameIndex + 1) % clip.frames.length;
            show(frameIndex);
            timer = window.setTimeout(tick, clip.delays[frameIndex]);
          }

          function stopTimer() {
            window.clearTimeout(timer);
            timer = 0;
          }

          function sync() {
            const shouldPlay = onScreen && clip.frames.length > 1 && (pinned || hovered || keyboardFocused);
            if (figure) figure.classList.toggle("is-playing", shouldPlay);
            if (shouldPlay && !playing) {
              playing = true;
              frameIndex = 0;
              show(0);
              stopTimer();
              timer = window.setTimeout(tick, clip.delays[0]);
            } else if (!shouldPlay && playing) {
              playing = false;
              stopTimer();
              frameIndex = 0;
              show(0);
            } else if (!shouldPlay) {
              show(0);
            }
          }

          const player = {
            unpin: function () {
              if (!pinned) return;
              pinned = false;
              if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false");
              sync();
            },
          };
          players.push(player);

          button.addEventListener("pointerdown", function (event) {
            pointerType = event.pointerType;
            fromPointer = true;
          });

          button.addEventListener("pointerenter", function (event) {
            if (reduceMotion || (event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
            hovered = true;
            sync();
          });

          button.addEventListener("pointerleave", function (event) {
            if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
            hovered = false;
            sync();
          });

          button.addEventListener("focus", function () {
            const viaPointer = fromPointer;
            fromPointer = false;
            if (reduceMotion || viaPointer) return;
            keyboardFocused = true;
            sync();
          });

          button.addEventListener("blur", function () {
            keyboardFocused = false;
            sync();
          });

          button.addEventListener("click", function () {
            const fromTouch = pointerType === "touch";
            if (!fromTouch && !reduceMotion && canHover) return;
            if (!pinned) {
              players.forEach(function (other) {
                if (other !== player) other.unpin();
              });
            }
            pinned = !pinned;
            if (button.hasAttribute("aria-pressed") || fromTouch) {
              button.setAttribute("aria-pressed", String(pinned));
            }
            sync();
          });

          if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver(function (entries) {
              onScreen = entries[0].isIntersecting;
              sync();
            });
            observer.observe(button);
          }

          show(0);
          img.replaceWith(button);
          sync();
        });
    }
  }

  if (typeof document !== "undefined") initHoverGifs();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseGif: parseGif, composeFrames: composeFrames };
  }
})();
