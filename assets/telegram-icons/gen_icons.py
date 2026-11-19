#!/usr/bin/env python3
"""Генератор иконок Telegram-чатов в общем стиле: плоский фон, белый силуэт, длинная тень.

Запуск:  python3 assets/telegram-icons/gen_icons.py
Пишет SVG в assets/telegram-icons/svg/. PNG — отдельно через qlmanage (в репозитории не храним).
"""
from pathlib import Path

OUT = Path(__file__).parent / "svg"

SHADOW_STEPS = 210  # копий силуэта со сдвигом по 2 px


def make_svg(sil: str, color: str, details: str = "", dy: int = 0) -> str:
    """Силуэт (белый) + цвет фона → SVG.

    sil     — фигуры силуэта (рисуются один раз в <g id="sil">)
    details — внутренние детали поверх белого; цвет фона подставляется вместо {bg}
    dy      — вертикальная подгонка по центру
    """
    shift = f'<g transform="translate(0,{dy})">' if dy else "<g>"
    shadow = "".join(
        f'<use href="#sil" transform="translate({2 * k},{2 * k})"/>' for k in range(1, SHADOW_STEPS + 1)
    )
    det = details.replace("{bg}", color)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><g id="sil" stroke-linecap="round" stroke-linejoin="round">{shift}
    {sil.strip()}</g></g><linearGradient id="fadeg" gradientUnits="userSpaceOnUse" x1="130" y1="130" x2="500" y2="500"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
  <mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="url(#fadeg)"/></mask>
  </defs>
  <rect width="512" height="512" fill="{color}"/>
  <g mask="url(#fade)" fill="#000" stroke="#000" opacity="0.28">{shadow}</g>
  <g fill="#fff" stroke="#fff"><use href="#sil"/></g>
  <g stroke-linecap="round" stroke-linejoin="round">{shift}{det.strip()}</g></g>
</svg>'''


# ---------- Магазин ----------

SHOP_BAG = dict(
    sil='''
    <path d="M150 214 H362 L376 392 a20 20 0 0 1 -20 22 H156 a20 20 0 0 1 -20 -22 Z" stroke="none"/>
    <path d="M206 236 V190 a50 50 0 0 1 100 0 V236" fill="none" stroke-width="22"/>''',
    details='''<circle cx="206" cy="250" r="11" fill="{bg}"/><circle cx="306" cy="250" r="11" fill="{bg}"/>''',
    dy=-14,
)

SCALLOPS = "".join(f'<circle cx="{142 + 38 * i}" cy="214" r="19" stroke="none"/>' for i in range(7))
SHOP_STALL = dict(
    sil=f'''
    <path d="M150 140 H362 L400 214 H112 Z" stroke="none"/>
    {SCALLOPS}
    <rect x="140" y="226" width="22" height="160" rx="6" stroke="none"/>
    <rect x="350" y="226" width="22" height="160" rx="6" stroke="none"/>
    <rect x="118" y="318" width="276" height="76" rx="14" stroke="none"/>''',
    details='''<path d="M218 146 L208 226 M294 146 L304 226" stroke="{bg}" stroke-width="9" fill="none"/>''',
    dy=-10,
)

SHOP_CART = dict(
    sil='''
    <path d="M104 160 H150 L170 200" fill="none" stroke-width="24"/>
    <path d="M160 196 H408 L380 318 a16 16 0 0 1 -16 12 H198 a16 16 0 0 1 -16 -12 Z" stroke="none"/>
    <path d="M190 330 L200 362 H372" fill="none" stroke-width="22"/>
    <circle cx="218" cy="398" r="26" stroke="none"/>
    <circle cx="356" cy="398" r="26" stroke="none"/>''',
    details='''<path d="M240 222 V304 M284 222 V304 M328 222 V304" stroke="{bg}" stroke-width="9" fill="none"/>''',
    dy=-14,
)

# ---------- Счета ИП ----------

IP_CARD = dict(
    sil='''
    <rect x="96" y="150" width="320" height="212" rx="26" stroke="none" transform="rotate(-10 256 256)"/>''',
    details='''<g transform="rotate(-10 256 256)">
      <rect x="96" y="190" width="320" height="38" fill="{bg}"/>
      <rect x="128" y="258" width="58" height="44" rx="9" fill="{bg}"/>
      <path d="M128 330 H230" stroke="{bg}" stroke-width="12" fill="none"/></g>''',
    dy=0,
)

IP_COINS = dict(
    sil='''
    <rect x="112" y="324" width="178" height="56" rx="28" stroke="none"/>
    <rect x="124" y="270" width="178" height="56" rx="28" stroke="none"/>
    <rect x="106" y="216" width="178" height="56" rx="28" stroke="none"/>
    <circle cx="330" cy="226" r="96" stroke="none"/>''',
    details='''<path d="M146 352 H256 M158 298 H268 M140 244 H250" stroke="{bg}" stroke-width="8" fill="none"/>
      <circle cx="330" cy="226" r="70" fill="none" stroke="{bg}" stroke-width="10"/>''',
    dy=-6,
)

IP_BANK = dict(
    sil='''
    <path d="M256 112 L404 196 H108 Z" stroke-width="20"/>
    <rect x="104" y="196" width="304" height="26" rx="6" stroke="none"/>
    <rect x="136" y="236" width="34" height="126" rx="6" stroke="none"/>
    <rect x="206" y="236" width="34" height="126" rx="6" stroke="none"/>
    <rect x="272" y="236" width="34" height="126" rx="6" stroke="none"/>
    <rect x="342" y="236" width="34" height="126" rx="6" stroke="none"/>
    <rect x="96" y="372" width="320" height="34" rx="8" stroke="none"/>''',
    details='''<circle cx="256" cy="164" r="15" fill="{bg}"/>''',
    dy=0,
)

ICONS = {
    # имя файла: (силуэт, цвет фона)
    "shop": (SHOP_CART, "#3d8bd9"),        # «##Магазин ШРСК (финансы)»
    "ip-accounts": (IP_CARD, "#2f855a"),   # «## Счета ИП ШРСК»
}

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, (spec, color) in ICONS.items():
        (OUT / f"{name}.svg").write_text(make_svg(color=color, **spec))
        print(f"{name}.svg  {color}")
