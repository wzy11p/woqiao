import Image from 'next/image';
import { APP_LOGO } from '@/config/brand';
import styles from './BrandMark.module.css';

export default function BrandMark() {
  return (
    <span className={styles.frame} aria-hidden="true">
      <Image src={APP_LOGO} alt="" width={52} height={52} sizes="52px" className={styles.bird} />
    </span>
  );
}
