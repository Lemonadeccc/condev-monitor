import Beams from '@/components/Beams'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="relative min-h-screen w-full overflow-hidden bg-black">
            <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
                <Beams
                    beamWidth={2}
                    beamHeight={15}
                    beamNumber={12}
                    lightColor="#ffffff"
                    speed={2}
                    noiseIntensity={1.75}
                    scale={0.2}
                    rotation={-30}
                />
            </div>
            <div className="absolute left-8 top-8 z-10 text-2xl font-bold text-white">CONDEV-MONITOR</div>
            <div className="relative z-10 flex min-h-screen w-full items-center justify-center">{children}</div>
        </div>
    )
}
