return function()
  local unicode = require("runtime").unicode
  local cases = {
    { "é", 1 },
    { "👩‍💻", 2 },
    { "👨‍👩‍👧‍👦", 2 },
    { "🇺🇸", 2 },
    { "1️⃣", 2 },
    { "❤️", 2 },
    { "क्ष", 2 },
    { "क्‍ष", 2 },
    { "각", 4 },
    { "a️", 1 },
  }
  for _, case in ipairs(cases) do
    local glyph, width = case[1], case[2]
    assert(unicode.width(glyph) == width, glyph)
    assert(unicode.dropLastGrapheme("x" .. glyph) == "x", glyph)
    assert(unicode.fit(glyph, width) == glyph, glyph)
    assert(unicode.fit(glyph .. "z", width, "") == glyph, glyph)
    local truncated = unicode.fit("x" .. glyph .. "z", width + 1, "…")
    assert(unicode.width(truncated) <= width + 1, glyph)
    assert(not truncated:find("�", 1, true), glyph)
    local wrapped = unicode.wrap(glyph .. "x", width)
    assert(wrapped[1] == glyph and wrapped[2] == "x", glyph)
  end
end
