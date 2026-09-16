import { useRef, useState } from 'react'
import { motion, useAnimationControls } from 'motion/react'
import type { LucideIcon } from 'lucide-react'

interface IconButtonProps {
  icon: LucideIcon
  label: string
  onClick?: () => void
  className?: string
  size?: number
  /** Rotate the icon 360° on hover (animate-ui IconButton pattern). */
  spinOnHover?: boolean
  disabled?: boolean
}

export default function IconButton({
  icon: Icon,
  label,
  onClick,
  className = '',
  size = 14,
  spinOnHover = false,
  disabled = false
}: IconButtonProps) {
  const controls = useAnimationControls()
  const [ripples, setRipples] = useState<number[]>([])
  const rippleId = useRef(0)

  function addRipple() {
    if (disabled) return
    const id = rippleId.current++
    setRipples((prev) => [...prev, id])
    setTimeout(() => setRipples((prev) => prev.filter((r) => r !== id)), 600)
  }

  return (
    <motion.button
      type="button"
      className={`icon-btn ${className}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        addRipple()
        onClick?.()
      }}
      onHoverStart={() => {
        if (spinOnHover) controls.start({ rotate: 360, transition: { duration: 0.6, ease: 'easeInOut' } })
      }}
      onHoverEnd={() => controls.start({ rotate: 0, transition: { duration: 0.3, ease: 'easeOut' } })}
      whileTap={disabled ? undefined : { scale: 0.86, transition: { duration: 0.12 } }}
    >
      <motion.span animate={controls} style={{ display: 'inline-flex' }}>
        <Icon size={size} strokeWidth={2.2} />
      </motion.span>
      {ripples.map((id) => (
        <motion.span
          key={id}
          className="icon-btn-ripple"
          initial={{ scale: 0, opacity: 0.35 }}
          animate={{ scale: 2.6, opacity: 0 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
        />
      ))}
    </motion.button>
  )
}