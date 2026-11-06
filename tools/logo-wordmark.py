# Hand-drawn pixel wordmark for Simulta: 2px-stroke glyphs 12 rows tall, each letter textured as a sim material.
import sys, random
from PIL import Image
G = {
"S": ["  ######  "," ######## ","###    ## ","###       "," ######   ","  ####### ","      ####","       ###","##     ###","######### "," #######  ","          "],
"I": ["######","######","  ##  ","  ##  ","  ##  ","  ##  ","  ##  ","  ##  ","  ##  ","######","######","      "],
"M": ["###     ###","####   ####","##### #####","## ##### ##","##  ###  ##","##   #   ##","##       ##","##       ##","##       ##","###     ###","###     ###","           "],
"U": ["###    ###","###    ###","##      ##","##      ##","##      ##","##      ##","##      ##","##      ##","###    ###"," ######## ","  ######  ","          "],
"L": ["###     ","###     ","##      ","##      ","##      ","##      ","##      ","##      ","##      ","########","########","        "],
"T": ["##########","##########","   ###    ","   ###    ","   ##     ","   ##     ","   ##     ","   ##     ","   ##     ","  ####    ","  ####    ","          "],
"A": ["   ####   ","  ######  "," ###  ### ","###    ###","##      ##","##      ##","##########","##########","##      ##","###    ###","###    ###","          "],
}
MATS = {  # (base, light, dark) per letter: sand, water, lava, moss, ice, fire, sand
 "S": ((220,193,120),(244,222,160),(176,146,82)),
 "I": ((58,116,216),(120,170,240),(36,74,160)),
 "M": ((224,60,20),(255,160,60),(150,30,14)),
 "U": ((79,122,42),(130,180,70),(50,82,26)),
 "L": ((168,228,240),(230,250,255),(110,170,196)),
 "T": ((255,122,28),(255,214,90),(196,70,16)),
 "A": ((220,193,120),(244,222,160),(176,146,82)),
}
# Usage: python3 tools/logo-wordmark.py mats client/public/logo/simulta-wordmark.png  (Menu redesign, D-209 draft)
mode = sys.argv[1]; out = sys.argv[2]
random.seed(4)
word = "SIMULTA"; gap = 2; pad = 3
W = sum(len(G[c][0]) for c in word) + gap*(len(word)-1) + pad*2; H = 12 + pad*2 + 4
img = Image.new("RGBA", (W, H), (0,0,0,0)); px = img.load()
mask = {}
x0 = pad
for c in word:
    rows = G[c]
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "#": mask[(x0+x, pad+y)] = c
    x0 += len(rows[0]) + gap
OUT = (14,10,18,255); SH = (0,0,0,150)
# shadow (offset 1,1 down-right) then outline
for (x,y) in mask:
    for dx,dy in ((1,1),(2,2),(1,2)):
        p=(x+dx,y+dy)
        if p not in mask and 0<=p[0]<W and 0<=p[1]<H: px[p]=SH
for (x,y) in mask:
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            p=(x+dx,y+dy)
            if p not in mask and 0<=p[0]<W and 0<=p[1]<H: px[p]=OUT
for (x,y),c in mask.items():
    base, light, dark = MATS[c] if mode=="mats" else MATS["S"]
    top = (x,y-1) not in mask; bot = (x,y+1) not in mask
    r = random.random()
    col = light if top or r < .12 else dark if bot or r > .88 else base
    px[x,y] = (*col,255)
# grains falling from the bottom edges
for (x,y),c in list(mask.items()):
    if (x,y+1) not in mask and random.random() < .10:
        base, light, dark = MATS[c] if mode=="mats" else MATS["S"]
        gy = y + 2 + random.randint(0,2)
        if gy < H and (x,gy) not in mask: px[x,gy] = (*base,255)
img.save(out)
print(W, H)
