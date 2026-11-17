import styles from './page.module.css'

const VELA_SAIL = [
  { d: 'M10 75L67 8L62 80Z', fill: '#2FB574' },
  { d: 'M73 18L107 98L72 85Z', fill: '#B6F1CE' },
  { d: 'M18 84L96 102L39 99Z', fill: '#187447' },
]

export default function PoweredBy() {
  return (
    <p className={styles.poweredBy}>
      <span>Powered by</span>
      <a href="https://vela.novacraft.africa" target="_blank" rel="noreferrer">
        <svg width={16} height={15} viewBox="0 0 120 110" aria-hidden>
          {VELA_SAIL.map(shape => <path key={shape.d} d={shape.d} fill={shape.fill} />)}
        </svg>
        Vela Mail
      </a>
      <span>by</span>
      <a href="https://novacraft.africa" target="_blank" rel="noreferrer">Novacraft</a>
    </p>
  )
}
