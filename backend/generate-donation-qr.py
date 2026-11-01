"""Generate the static UPI Number donation QR as an SVG using only Python stdlib."""
from pathlib import Path
import urllib.parse

PHONE = '7771036412'
PAYEE = 'ISKCON Nagda Community'
PAYMENT_URI = 'upi://pay?' + urllib.parse.urlencode({
    'pa': PHONE + '@mapper.npci',
    'pn': PAYEE,
    'cu': 'INR',
    'tn': 'Temple Donation',
})

VERSION = 6
SIZE = VERSION * 4 + 17
DATA_CODEWORDS = 108
ECC_PER_BLOCK = 16
BLOCKS = 4


def append_bits(target, value, length):
    target.extend((value >> i) & 1 for i in range(length - 1, -1, -1))


def gf_multiply(x, y):
    product = 0
    for _ in range(8):
        if y & 1:
            product ^= x
        y >>= 1
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    return product


def reed_solomon_remainder(data, degree):
    generator = [1]
    root = 1
    for _ in range(degree):
        next_poly = [0] * (len(generator) + 1)
        for index, coefficient in enumerate(generator):
            next_poly[index] ^= coefficient
            next_poly[index + 1] ^= gf_multiply(coefficient, root)
        generator = next_poly
        root = gf_multiply(root, 2)
    remainder = [0] * degree
    for byte in data:
        factor = byte ^ remainder[0]
        remainder = remainder[1:] + [0]
        for index in range(degree):
            remainder[index] ^= gf_multiply(generator[index + 1], factor)
    return remainder


def make_codewords():
    payload = PAYMENT_URI.encode('utf-8')
    bits = []
    append_bits(bits, 0b0100, 4)  # byte mode
    append_bits(bits, len(payload), 8)  # version 6 uses an 8-bit byte count
    for byte in payload:
        append_bits(bits, byte, 8)
    capacity = DATA_CODEWORDS * 8
    bits.extend([0] * min(4, capacity - len(bits)))
    while len(bits) % 8:
        bits.append(0)
    data = [sum(bits[i + j] << (7 - j) for j in range(8)) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < DATA_CODEWORDS:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    blocks = [data[i * 27:(i + 1) * 27] for i in range(BLOCKS)]
    ecc = [reed_solomon_remainder(block, ECC_PER_BLOCK) for block in blocks]
    return (
        [blocks[b][i] for i in range(27) for b in range(BLOCKS)] +
        [ecc[b][i] for i in range(ECC_PER_BLOCK) for b in range(BLOCKS)]
    )


def bch_remainder(value, polynomial):
    while value.bit_length() >= polynomial.bit_length():
        value ^= polynomial << (value.bit_length() - polynomial.bit_length())
    return value


def make_matrix(mask):
    modules = [[None] * SIZE for _ in range(SIZE)]

    def set_function(x, y, value):
        modules[y][x] = bool(value)

    def finder(cx, cy):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                x, y = cx + dx, cy + dy
                if 0 <= x < SIZE and 0 <= y < SIZE:
                    dark = 0 <= dx <= 6 and 0 <= dy <= 6 and (
                        dx in (0, 6) or dy in (0, 6) or (2 <= dx <= 4 and 2 <= dy <= 4)
                    )
                    set_function(x, y, dark)

    finder(0, 0)
    finder(SIZE - 7, 0)
    finder(0, SIZE - 7)
    for i in range(8, SIZE - 8):
        set_function(6, i, i % 2 == 0)
        set_function(i, 6, i % 2 == 0)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            set_function(34 + dx, 34 + dy, max(abs(dx), abs(dy)) != 1)

    format_data = mask  # error correction level M has format bits 00
    format_bits = ((format_data << 10) | bch_remainder(format_data << 10, 0x537)) ^ 0x5412
    for i in range(6):
        set_function(8, i, (format_bits >> i) & 1)
    set_function(8, 7, (format_bits >> 6) & 1)
    set_function(8, 8, (format_bits >> 7) & 1)
    set_function(7, 8, (format_bits >> 8) & 1)
    for i in range(9, 15):
        set_function(14 - i, 8, (format_bits >> i) & 1)
    for i in range(8):
        set_function(SIZE - 1 - i, 8, (format_bits >> i) & 1)
    for i in range(8, 15):
        set_function(8, SIZE - 15 + i, (format_bits >> i) & 1)
    set_function(8, SIZE - 8, True)

    all_codewords = make_codewords()
    data_bits = [((byte >> i) & 1) for byte in all_codewords for i in range(7, -1, -1)]
    bit_index = 0
    upward = True
    right = SIZE - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(SIZE):
            y = SIZE - 1 - vert if upward else vert
            for offset in range(2):
                x = right - offset
                if modules[y][x] is None:
                    bit = data_bits[bit_index] if bit_index < len(data_bits) else 0
                    bit_index += 1
                    invert = (
                        (y + x) % 2 == 0,
                        y % 2 == 0,
                        x % 3 == 0,
                        (y + x) % 3 == 0,
                        (y // 2 + x // 3) % 2 == 0,
                        (y * x) % 2 + (y * x) % 3 == 0,
                        ((y * x) % 2 + (y * x) % 3) % 2 == 0,
                        ((y + x) % 2 + (y * x) % 3) % 2 == 0,
                    )[mask]
                    modules[y][x] = bool(bit ^ invert)
        upward = not upward
        right -= 2
    return modules


def penalty(matrix):
    score = 0
    lines = matrix + [list(col) for col in zip(*matrix)]
    for line in lines:
        run_color, run_length = line[0], 1
        for color in line[1:]:
            if color == run_color:
                run_length += 1
            else:
                if run_length >= 5:
                    score += run_length - 2
                run_color, run_length = color, 1
        if run_length >= 5:
            score += run_length - 2
        for i in range(len(line) - 10):
            pattern = line[i:i + 11]
            if pattern == [False, False, False, False, True, False, True, True, True, False, True]:
                score += 40
            if pattern == [True, False, True, True, True, False, True, False, False, False, False]:
                score += 40
    for y in range(SIZE - 1):
        for x in range(SIZE - 1):
            color = matrix[y][x]
            if matrix[y][x + 1] == color and matrix[y + 1][x] == color and matrix[y + 1][x + 1] == color:
                score += 3
    dark = sum(sum(row) for row in matrix)
    score += (abs(dark * 100 // (SIZE * SIZE) - 50) // 5) * 10
    return score


best = min((make_matrix(mask) for mask in range(8)), key=penalty)
quiet = 4
scale = 8
dimension = (SIZE + quiet * 2) * scale
rects = []
for y, row in enumerate(best):
    for x, dark in enumerate(row):
        if dark:
            rects.append(f'<rect x="{(x + quiet) * scale}" y="{(y + quiet) * scale}" width="{scale}" height="{scale}"/>')
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{dimension}" height="{dimension}" '
    f'viewBox="0 0 {dimension} {dimension}" role="img" aria-label="UPI donation payment QR code">'
    f'<rect width="{dimension}" height="{dimension}" fill="#fff"/>'
    f'<g fill="#000">{"".join(rects)}</g></svg>\n'
)
output = Path(__file__).resolve().parent.parent / 'frontend' / 'donation-upi-qr.svg'
output.write_text(svg, encoding='utf-8')
print(f'Created {output}')
