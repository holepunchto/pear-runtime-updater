module.exports = lt

function lt(a, b) {
  const pa = parse(a)
  const pb = parse(b)

  for (let i = 0; i < 3; i++) {
    if (pa.version[i] !== pb.version[i]) return pa.version[i] < pb.version[i]
  }

  if (!pa.pre && !pb.pre) return false
  if (!pa.pre !== !pb.pre) return !!pa.pre

  const len = Math.max(pa.pre.length, pb.pre.length)

  for (let i = 0; i < len; i++) {
    if (i >= pa.pre.length || i >= pb.pre.length) return i >= pa.pre.length

    const an = +pa.pre[i]
    const bn = +pb.pre[i]
    const anum = an === an
    const bnum = bn === bn

    if (anum !== bnum) return anum
    if (pa.pre[i] !== pb.pre[i]) return anum ? an < bn : pa.pre[i] < pb.pre[i]
  }

  return false
}

function parse(v) {
  const b = v.indexOf('+')
  if (b !== -1) v = v.substring(0, b)

  const i = v.indexOf('-')

  return {
    version: (i === -1 ? v : v.substring(0, i)).split('.').map(Number),
    pre: i === -1 ? null : v.substring(i + 1).split('.')
  }
}
