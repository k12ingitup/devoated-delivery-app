import dynamic from 'next/dynamic'

// Camera and Canvas APIs require the browser — disable SSR for this component
const PhotoBooth = dynamic(() => import('../components/PhotoBooth'), { ssr: false })

export default function Home() {
  return <PhotoBooth />
}
